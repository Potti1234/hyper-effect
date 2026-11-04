import http from 'node:http'

/* Fan-out load test for the Dispatch board (experiment 1).

   Opens N live board sessions the way a browser would (page GET with its own
   visitor cookie, then the SSE stream), lets a driver session change shared
   state R times per second for D seconds, and measures how long every page
   waits for its morph, plus server CPU, render time and memory.

   Requires a server started with HYPER_METRICS=1.
   Usage: node scripts/load-test.mjs --sessions 200 --rate 1 --duration 20 [--url http://localhost:3000] [--direct 1] [--events 0.5]
   --encoding br|gzip|identity: what pages accept for their stream (default
   br, as browsers send; compressed only if the server has compression on).
   --events n: every page also clicks its own selection n times a second, and
   the time until each click is answered is reported (with durable events, an
   answer waits for the session's snapshot write). Own clicks add patches, so
   the fan-out latency is then only indicative.
   --direct 1: against src/cluster.ts, sends each session's stream and events
   straight to its worker instead of through the router (to measure the
   router's cost). */

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]])
    return pairs
  }, []),
)
const base = args.url ?? 'http://localhost:3000'
const sessionCount = Number(args.sessions ?? 50)
const rate = Number(args.rate ?? 1)
const duration = Number(args.duration ?? 15)
const batch = Number(args.batch ?? 25)
const direct = args.direct === '1'
const eventsPerPage = Number(args.events ?? 0)
const acceptEncoding = args.encoding ?? 'br'
// --raw 1: read streams with node:http, without decoding, and count every
// chunk as a patch: when the server compresses, this times the bytes on the
// wire rather than the client's decoder.
const raw = args.raw === '1'

const sleep = millis => new Promise(resolve => setTimeout(resolve, millis))
const metrics = async () => (await fetch(`${base}/_hyper/metrics`)).json()
const token = value => Buffer.from(JSON.stringify(value)).toString('base64url')

let signedIn = 0

// With --direct: node name → worker origin, from the router.
const workers = direct
  ? new Map((await (await fetch(`${base}/_hyper/cluster`)).json()).map(({ node, port }) => [node, `http://localhost:${port}`]))
  : new Map()
const originOf = path => workers.get(path.match(/\/s\/([a-z0-9]+)\./)?.[1]) ?? base

/** Signs in as a new dispatcher, then opens the board with that browser's
 *  cookies (visitor plus signed-in user). */
const openPage = async () => {
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ name: `Load ${(signedIn += 1)}`, next: '/' }),
    redirect: 'manual',
  })
  const userCookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  const response = await fetch(`${base}/`, { headers: { cookie: userCookie } })
  const cookie = `${(response.headers.get('set-cookie') ?? '').split(';')[0]}; ${userCookie}`
  const html = await response.text()
  const stream = html.match(/@get\('([^']+)'\)/)?.[1]
  const endpoint = stream?.replace(/\/stream\?.*$/, '')
  if (stream === undefined || endpoint === undefined) throw new Error('no stream in page')
  return { cookie, stream: stream.replace(/&amp;/g, '&'), endpoint, origin: originOf(endpoint) }
}

/** Records the arrival of every raw chunk (see --raw). */
const listenRaw = (page, controller) => {
  const arrivals = []
  const request = http.get(`${page.origin}${page.stream}`, {
    headers: { cookie: page.cookie, 'datastar-request': 'true', accept: 'text/event-stream', 'accept-encoding': acceptEncoding },
    signal: controller.signal,
  })
  request.on('response', response => response.on('data', () => arrivals.push(performance.now())))
  request.on('error', () => {})
  return arrivals
}

/** Opens the SSE stream and records the arrival time of every patch. */
const listen = async (page, controller) => {
  if (raw) return listenRaw(page, controller)
  const arrivals = []
  const response = await fetch(`${page.origin}${page.stream}`, {
    headers: { cookie: page.cookie, 'datastar-request': 'true', accept: 'text/event-stream', 'accept-encoding': acceptEncoding },
    signal: controller.signal,
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  ;(async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const event = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          if (event.startsWith('event: datastar-patch-elements')) arrivals.push(performance.now())
        }
      }
    } catch {}
  })()
  return arrivals
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? NaN
const ms = value => `${value.toFixed(1)} ms`
const mb = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`

console.log(`load test: ${sessionCount} pages, ${rate} change/s for ${duration} s against ${base}`)
await fetch(`${base}/_hyper/metrics/reset`, { method: 'POST' })
const before = await metrics()

// ── Connect ───────────────────────────────────────────────────────────────
const controller = new AbortController()
const listeners = []
const connectStart = performance.now()
for (let index = 0; index < sessionCount; index += batch) {
  const pages = await Promise.all(
    Array.from({ length: Math.min(batch, sessionCount - index) }, () => openPage()),
  )
  for (const page of pages) listeners.push({ page, arrivals: await listen(page, controller) })
}
const connectMillis = performance.now() - connectStart

// Wait for the connect storm (presence changes re-render every page) to settle.
let settled = await metrics()
for (let quiet = 0; quiet < 3; ) {
  await sleep(1000)
  const next = await metrics()
  quiet = next.renders === settled.renders ? quiet + 1 : 0
  settled = next
}
const afterConnect = settled
const rampRenders = afterConnect.renders - before.renders

// ── Drive ─────────────────────────────────────────────────────────────────
const driver = await openPage()
const driverController = new AbortController()
await listen(driver, driverController)
await sleep(500)
await fetch(`${base}/_hyper/metrics/reset`, { method: 'POST' })
const driveStart = await metrics()
const generatorStart = process.cpuUsage()
const startWall = performance.now()
const sends = []
let sequence = 0
const ticks = Math.round(duration * rate)

// Every page clicks its own selection (--events), recording answer times.
const answers = []
let clicking = eventsPerPage > 0
const clickLoop = async ({ page }) => {
  const interval = 1000 / eventsPerPage
  await sleep(Math.random() * interval)
  for (let q = 1; clicking; q += 1) {
    const sentAt = performance.now()
    const response = await fetch(`${page.origin}${page.endpoint}`, {
      method: 'POST',
      headers: { cookie: page.cookie, 'content-type': 'application/json', 'datastar-request': 'true', origin: page.origin },
      body: JSON.stringify({ m: token({ _tag: 'ClickedIncident', id: q % 2 === 0 ? 'INC-102' : 'INC-103' }), q, p: {} }),
    }).catch(() => undefined)
    if (response?.status === 204) answers.push(performance.now() - sentAt)
    await sleep(Math.max(0, interval - (performance.now() - sentAt)))
  }
}
const clickers = eventsPerPage > 0 ? listeners.map(clickLoop) : []
for (let tick = 0; tick < ticks; tick += 1) {
  const message = tick % 2 === 0 ? 'ClickedTakeIncident' : 'ClickedReopenIncident'
  sequence += 1
  const sentAt = performance.now()
  sends.push(sentAt)
  await fetch(`${driver.origin}${driver.endpoint}`, {
    method: 'POST',
    headers: {
      cookie: driver.cookie,
      'content-type': 'application/json',
      'datastar-request': 'true',
      // The page's origin is the one it was loaded from; direct posts go to
      // the worker, whose origin check expects its own host.
      origin: driver.origin,
    },
    body: JSON.stringify({ m: token({ _tag: message, id: 'INC-101' }), q: sequence, p: {} }),
  })
  const next = startWall + ((tick + 1) * 1000) / rate
  await sleep(Math.max(0, next - performance.now()))
}
await sleep(2000)
const driveEnd = await metrics()
const wallMillis = performance.now() - startWall
const generatorCpu = process.cpuUsage(generatorStart)
clicking = false
await Promise.all(clickers)
answers.sort((a, b) => a - b)

// ── Report ────────────────────────────────────────────────────────────────
const latencies = []
let missed = 0
for (const { arrivals } of listeners) {
  sends.forEach((sentAt, index) => {
    const until = sends[index + 1] ?? Infinity
    const arrival = arrivals.find(time => time > sentAt && time < until + 1500)
    if (arrival === undefined) missed += 1
    else latencies.push(arrival - sentAt)
  })
}
latencies.sort((a, b) => a - b)
const cpuMicros =
  driveEnd.cpuUserMicros + driveEnd.cpuSystemMicros - (driveStart.cpuUserMicros + driveStart.cpuSystemMicros)
const result = {
  sessions: sessionCount,
  ratePerSecond: rate,
  connectSeconds: +(connectMillis / 1000).toFixed(1),
  rampRenders,
  rssPerSessionKb: +((afterConnect.rssBytes - before.rssBytes) / sessionCount / 1024).toFixed(0),
  heapPerSessionKb: +((afterConnect.heapUsedBytes - before.heapUsedBytes) / sessionCount / 1024).toFixed(0),
  latencyP50: +percentile(latencies, 0.5).toFixed(1),
  latencyP95: +percentile(latencies, 0.95).toFixed(1),
  latencyP99: +percentile(latencies, 0.99).toFixed(1),
  latencyMax: +(latencies.at(-1) ?? NaN).toFixed(1),
  missedUpdates: missed,
  renders: driveEnd.renders,
  renderMean: +driveEnd.renderMeanMillis.toFixed(2),
  renderP95: +driveEnd.renderP95Millis.toFixed(2),
  cpuPercentOfOneCore: +((cpuMicros / 1000 / wallMillis) * 100).toFixed(0),
  eventLoopUtilization: +driveEnd.eventLoopUtilization.toFixed(2),
  patchKbPerSecond: +((driveEnd.patchBytes / 1024) / (wallMillis / 1000)).toFixed(0),
  /** After compression, when the server compresses; else 0. */
  wireKbPerSecond: +(((driveEnd.wireBytes ?? 0) / 1024) / (wallMillis / 1000)).toFixed(0),
  patchBytesMean: driveEnd.patches === 0 ? 0 : Math.round(driveEnd.patchBytes / driveEnd.patches),
  regionPatchShare: driveEnd.patches === 0 ? 0 : +((driveEnd.regionPatches ?? 0) / driveEnd.patches).toFixed(2),
  regionsRendered: driveEnd.regionRenders ?? 0,
  regionsUnchanged: driveEnd.regionUnchanged ?? 0,
  regionsKept: driveEnd.regionKept ?? 0,
  processes: driveEnd.processes ?? 1,
  eventsPerSecond: +((answers.length / wallMillis) * 1000).toFixed(0),
  answerP50: +percentile(answers, 0.5).toFixed(1),
  answerP95: +percentile(answers, 0.95).toFixed(1),
  answerP99: +percentile(answers, 0.99).toFixed(1),
  /** This load generator's own CPU: near 100% means it, not the server, limits the measurement. */
  generatorCpuPercent: +(((generatorCpu.user + generatorCpu.system) / 1000 / wallMillis) * 100).toFixed(0),
}
console.log(
  [
    `connect: ${result.connectSeconds} s, ${rampRenders} renders while connecting`,
    `memory: ~${result.rssPerSessionKb} kB RSS / ${result.heapPerSessionKb} kB heap per session (rss now ${mb(afterConnect.rssBytes)})`,
    `update latency: p50 ${ms(result.latencyP50)}, p95 ${ms(result.latencyP95)}, p99 ${ms(result.latencyP99)}, max ${ms(result.latencyMax)}, missed ${missed}`,
    `server: ${result.renders} renders, mean ${ms(result.renderMean)}, p95 ${ms(result.renderP95)}, CPU ${result.cpuPercentOfOneCore}% of one core over ${result.processes} process(es), ${result.patchKbPerSecond} kB/s of patches (uncompressed)${result.wireKbPerSecond > 0 ? `, ${result.wireKbPerSecond} kB/s on the wire` : ''}`,
    `load generator: ${result.generatorCpuPercent}% of one core${direct ? ', direct to workers' : ''}`,
    ...(eventsPerPage > 0
      ? [`page events: ${result.eventsPerSecond}/s answered, p50 ${ms(result.answerP50)}, p95 ${ms(result.answerP95)}, p99 ${ms(result.answerP99)}`]
      : []),
    `patches: ${result.patchBytesMean} bytes on average, ${Math.round(result.regionPatchShare * 100)}% regions only; regions kept ${result.regionsKept}, rendered unchanged ${result.regionsUnchanged}, rendered new ${result.regionsRendered}`,
  ].join('\n'),
)
console.log(`RESULT ${JSON.stringify(result)}`)

controller.abort()
driverController.abort()
process.exit(0)
