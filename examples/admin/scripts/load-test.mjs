/* Load test for the catalog admin (phase B6): N product lists open, one
   editor saving a product R times a second. Every list re-queries the
   catalog on every change, so the query (in memory, or Postgres with
   DATABASE_URL) is part of the cost, not just the render.

   Requires a server started with HYPER_METRICS=1.
   Usage: node scripts/load-test.mjs --sessions 200 --rate 1 --duration 15 [--varied 1] [--url http://localhost:3200]
   --varied 1: every list has its own query (search, category, status, sort,
   page), as real users would; otherwise all show the first page, which the
   saved product moves to the top of. */

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]])
    return pairs
  }, []),
)
const base = args.url ?? 'http://localhost:3200'
const sessionCount = Number(args.sessions ?? 50)
const rate = Number(args.rate ?? 1)
const duration = Number(args.duration ?? 15)
const varied = args.varied === '1'

const sleep = millis => new Promise(resolve => setTimeout(resolve, millis))
const metrics = async () => (await fetch(`${base}/_hyper/metrics`)).json()
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? NaN

const QUERIES = [
  '',
  '?sort=price',
  '?category=Kitchen',
  '?q=lamp',
  '?page=3',
  '?status=draft&sort=name&dir=asc',
  '?category=Tools&sort=stock&dir=desc',
  '?q=steel&page=1',
]

const signIn = async name => {
  const response = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ name, next: '/products' }),
    redirect: 'manual',
  })
  return (response.headers.get('set-cookie') ?? '').split(';')[0]
}

const openList = async index => {
  const userCookie = await signIn('ada')
  const query = varied ? QUERIES[index % QUERIES.length] : ''
  const response = await fetch(`${base}/products${query}`, { headers: { cookie: userCookie } })
  const cookie = `${(response.headers.get('set-cookie') ?? '').split(';')[0]}; ${userCookie}`
  const html = await response.text()
  const stream = html.match(/@get\('([^']+)'\)/)?.[1]?.replace(/&amp;/g, '&')
  if (stream === undefined) throw new Error(`no stream in page (${response.status})`)
  const arrivals = []
  const controller = new AbortController()
  const body = (
    await fetch(`${base}${stream}`, {
      headers: { cookie, 'datastar-request': 'true', accept: 'text/event-stream' },
      signal: controller.signal,
    })
  ).body.getReader()
  ;(async () => {
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await body.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          if (buffer.slice(0, boundary).startsWith('event: datastar-patch-elements')) arrivals.push(performance.now())
          buffer = buffer.slice(boundary + 2)
        }
      }
    } catch {}
  })()
  return { arrivals, controller }
}

/** Saves P0001 with a new stock value, as the edit page does: the typed value
 *  rides along with the save as a pending input. */
const editorCookie = await signIn('ada')
const save = async stock => {
  const response = await fetch(`${base}/products/P0001`, { headers: { cookie: editorCookie } })
  const cookie = `${(response.headers.get('set-cookie') ?? '').split(';')[0]}; ${editorCookie}`
  const html = await response.text()
  const endpoint = html.match(/data-signals:_he="'([^']+)'"/)?.[1]
  const stockHandler = html.match(/<input[^>]*data-hyper-input="([^"]+)"[^>]*id="stock"/)?.[1]
  const saveToken = html.match(/id="product-form"/) && html.match(/<form data-on:submit__prevent="[^"]*m: '([^']+)'/)?.[1]
  if (endpoint === undefined || stockHandler === undefined || !saveToken) throw new Error('edit page not understood')
  const sentAt = performance.now()
  const posted = await fetch(`${base}${endpoint}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'datastar-request': 'true', origin: base },
    body: JSON.stringify({ m: saveToken, q: 1, p: { [stockHandler]: String(stock) } }),
  })
  if (posted.status !== 204) throw new Error(`save answered ${posted.status}`)
  return sentAt
}

console.log(`admin load test: ${sessionCount} lists${varied ? ' (varied queries)' : ''}, ${rate} save/s for ${duration} s against ${base}`)
await fetch(`${base}/_hyper/metrics/reset`, { method: 'POST' })
const before = await metrics()
const lists = []
for (let index = 0; index < sessionCount; index += 25) {
  lists.push(...(await Promise.all(Array.from({ length: Math.min(25, sessionCount - index) }, (_, offset) => openList(index + offset)))))
}
await sleep(2000)
const afterConnect = await metrics()
await fetch(`${base}/_hyper/metrics/reset`, { method: 'POST' })
const driveStart = await metrics()
const startWall = performance.now()
const sends = []
const ticks = Math.round(duration * rate)
for (let tick = 0; tick < ticks; tick += 1) {
  sends.push(await save(100 + (tick % 50)))
  await sleep(Math.max(0, startWall + ((tick + 1) * 1000) / rate - performance.now()))
}
await sleep(2000)
const driveEnd = await metrics()
const wallMillis = performance.now() - startWall

const latencies = []
let unchanged = 0
for (const { arrivals } of lists) {
  sends.forEach((sentAt, index) => {
    const until = sends[index + 1] ?? Infinity
    const arrival = arrivals.find(time => time > sentAt && time < until + 1500)
    if (arrival === undefined) unchanged += 1
    else latencies.push(arrival - sentAt)
  })
}
latencies.sort((a, b) => a - b)
const cpuMicros = driveEnd.cpuUserMicros + driveEnd.cpuSystemMicros - (driveStart.cpuUserMicros + driveStart.cpuSystemMicros)
const result = {
  sessions: sessionCount,
  varied,
  ratePerSecond: rate,
  latencyP50: +percentile(latencies, 0.5).toFixed(1),
  latencyP95: +percentile(latencies, 0.95).toFixed(1),
  latencyP99: +percentile(latencies, 0.99).toFixed(1),
  /** Page-changes with no patch: the list did not change for that page. */
  unchanged,
  renders: driveEnd.renders,
  renderMean: +driveEnd.renderMeanMillis.toFixed(2),
  cpuPercentOfOneCore: +((cpuMicros / 1000 / wallMillis) * 100).toFixed(0),
  rssPerSessionKb: +((afterConnect.rssBytes - before.rssBytes) / sessionCount / 1024).toFixed(0),
  patchBytesMean: driveEnd.patches === 0 ? 0 : Math.round(driveEnd.patchBytes / driveEnd.patches),
}
console.log(
  `latency: p50 ${result.latencyP50} ms, p95 ${result.latencyP95} ms, p99 ${result.latencyP99} ms; ${unchanged} page-changes without a patch\n` +
    `server: ${result.renders} renders, mean ${result.renderMean} ms, CPU ${result.cpuPercentOfOneCore}% of one core, ~${result.rssPerSessionKb} kB RSS per list, ${result.patchBytesMean} bytes per patch`,
)
console.log(`RESULT ${JSON.stringify(result)}`)
lists.forEach(list => list.controller.abort())
process.exit(0)
