import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, openSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/* Soak test (phase B6): the Dispatch board for a long time under steady load
   with churn, sampling memory and everything a session or the process keeps.

   - `pages` live pages; every minute `churn` of them close (their sessions
     expire after the idle timeout) and as many new ones open.
   - A driver changes shared state `rate` times a second; every page clicks
     its own selection `events` times a second.
   - Every 30 s: RSS and heap (after a forced GC), sessions, handler tables,
     regions, the shared-region cache, snapshot files on disk, render time,
     event-loop lag, failed requests.
   - At the end: the growth per hour after a warm-up, by least squares.

   usage: node tools/perf/soak.mjs [minutes=120] [pages=200] [churn=20] [events=0.2] [rate=1]
   Writes output/soak.jsonl (one sample per line) and output/soak-server.log. */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const app = join(root, 'examples', 'dispatch')
const [minutes = 120, pageCount = 200, churn = 20, eventsPerPage = 0.2, rate = 1] = process.argv.slice(2).map(Number)
const PORT = 3400
const base = `http://localhost:${PORT}`
const sessionsDir = '.hyper-sessions-soak'
const WARMUP_MINUTES = Math.min(10, minutes / 4)

mkdirSync(join(root, 'output'), { recursive: true })
const samplesFile = join(root, 'output', 'soak.jsonl')
writeFileSync(samplesFile, '')
rmSync(join(app, sessionsDir), { recursive: true, force: true })

const log = openSync(join(root, 'output', 'soak-server.log'), 'w')
const server = spawn(process.execPath, ['--expose-gc', '--import', 'tsx', 'src/main.ts'], {
  cwd: app,
  env: {
    ...process.env,
    PORT: String(PORT),
    NODE_ENV: 'production',
    HYPER_METRICS: '1',
    DISPATCH_PRESENCE_SAMPLE_SECONDS: '2',
    DISPATCH_SESSIONS_DIR: sessionsDir,
  },
  stdio: ['ignore', log, log],
})
const stop = () => {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' })
  else server.kill('SIGKILL')
}
process.on('exit', stop)

const sleep = millis => new Promise(resolve => setTimeout(resolve, millis))
const token = value => Buffer.from(JSON.stringify(value)).toString('base64url')
const metrics = async () => (await fetch(`${base}/_hyper/metrics`)).json()
const failures = { streams: 0, events: 0, pageLoads: 0 }

for (let attempt = 0; attempt < 240; attempt += 1) {
  if (await fetch(`${base}/greeter`).then(response => response.ok, () => false)) break
  await sleep(500)
}

let signedIn = 0
const openPage = async () => {
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ name: `Soak ${(signedIn += 1)}`, next: '/' }),
    redirect: 'manual',
  })
  const userCookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  const response = await fetch(`${base}/`, { headers: { cookie: userCookie } })
  const cookie = `${(response.headers.get('set-cookie') ?? '').split(';')[0]}; ${userCookie}`
  const html = await response.text()
  const stream = html.match(/@get\('([^']+)'\)/)?.[1]?.replace(/&amp;/g, '&')
  if (stream === undefined) throw new Error('no stream in page')
  const page = { cookie, stream, endpoint: stream.replace(/\/stream\?.*$/, ''), q: 0, controller: new AbortController(), open: true }
  fetch(`${base}${page.stream}`, {
    headers: { cookie, 'datastar-request': 'true', accept: 'text/event-stream' },
    signal: page.controller.signal,
  })
    .then(async response => {
      const reader = response.body.getReader()
      while (!(await reader.read()).done) {}
      if (page.open) failures.streams += 1
    })
    .catch(() => {
      if (page.open) failures.streams += 1
    })
  return page
}
const post = (page, message) =>
  fetch(`${base}${page.endpoint}`, {
    method: 'POST',
    headers: { cookie: page.cookie, 'content-type': 'application/json', 'datastar-request': 'true', origin: base },
    body: JSON.stringify({ m: token(message), q: (page.q += 1), p: {} }),
  }).then(
    response => {
      if (response.status !== 204) failures.events += 1
    },
    () => {
      failures.events += 1
    },
  )
const close = page => {
  page.open = false
  page.controller.abort()
}

let pages = []
for (let index = 0; index < pageCount; index += 25) {
  pages.push(...(await Promise.all(Array.from({ length: Math.min(25, pageCount - index) }, openPage))))
}
const driver = await openPage()

const startedAt = Date.now()
const endsAt = startedAt + minutes * 60_000
const running = () => Date.now() < endsAt

// Shared changes.
const driving = (async () => {
  for (let tick = 0; running(); tick += 1) {
    await post(driver, { _tag: tick % 2 === 0 ? 'ClickedTakeIncident' : 'ClickedReopenIncident', id: 'INC-101' })
    await sleep(1000 / rate)
  }
})()

// Own clicks, spread over the pages.
const clicking = (async () => {
  if (eventsPerPage <= 0) return
  const interval = 1000 / (eventsPerPage * pageCount)
  for (let index = 0; running(); index += 1) {
    const page = pages[index % pages.length]
    if (page?.open) void post(page, { _tag: 'ClickedIncident', id: index % 2 === 0 ? 'INC-102' : 'INC-103' })
    await sleep(interval)
  }
})()

// Churn: the oldest pages leave, new ones arrive.
const churning = (async () => {
  while (running()) {
    await sleep(60_000)
    if (!running()) break
    const leaving = pages.slice(0, churn)
    leaving.forEach(close)
    const arriving = await Promise.all(Array.from({ length: churn }, () => openPage().catch(() => (failures.pageLoads += 1, undefined))))
    pages = [...pages.slice(churn), ...arriving.filter(Boolean)]
  }
})()

const samples = []
const sampling = (async () => {
  while (running()) {
    const m = await metrics().catch(() => undefined)
    if (m !== undefined) {
      const board = m.programs?.board ?? {}
      const sample = {
        minute: +((Date.now() - startedAt) / 60_000).toFixed(1),
        rssMb: +(m.rssBytes / 1048576).toFixed(1),
        heapMb: +(m.heapUsedBytes / 1048576).toFixed(1),
        sessions: board.sessions,
        connections: board.connections,
        handlerTables: board.handlerTables,
        regions: board.regions,
        sharedRegionKeys: m.gauges?.sharedRegionKeys,
        snapshotFiles: readdirSync(join(app, sessionsDir)).length,
        renderMeanMs: +m.renderMeanMillis.toFixed(2),
        lagMs: +m.eventLoopLagMillis.toFixed(1),
        ...failures,
      }
      samples.push(sample)
      appendFileSync(samplesFile, `${JSON.stringify(sample)}\n`)
      console.log(Object.entries(sample).map(([key, value]) => `${key}=${value}`).join(' '))
    }
    await sleep(30_000)
  }
})()

await Promise.all([driving, clicking, churning, sampling])

/** Least-squares slope of `key` per hour over the samples after warm-up. */
const perHour = key => {
  const points = samples.filter(sample => sample.minute >= WARMUP_MINUTES).map(sample => [sample.minute / 60, sample[key]])
  if (points.length < 2) return NaN
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / points.length
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / points.length
  const covariance = points.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0)
  const variance = points.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0)
  return +(covariance / variance).toFixed(2)
}
const first = samples.find(sample => sample.minute >= WARMUP_MINUTES)
const last = samples.at(-1)
const result = {
  minutes,
  pages: pageCount,
  churnPerMinute: churn,
  heapMbAfterWarmup: first?.heapMb,
  heapMbAtEnd: last?.heapMb,
  heapMbPerHour: perHour('heapMb'),
  rssMbPerHour: perHour('rssMb'),
  handlerTablesPerHour: perHour('handlerTables'),
  regionsPerHour: perHour('regions'),
  snapshotFilesAtEnd: last?.snapshotFiles,
  sessionsAtEnd: last?.sessions,
  ...failures,
}
console.log(`RESULT ${JSON.stringify(result)}`)
pages.forEach(close)
close(driver)
stop()
process.exit(0)
