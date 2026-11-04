import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, openSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { secrets } from '../secrets.mjs'
import { startBalancer } from './balancer.mjs'

/* Experiment 5, part 2: two Dispatch nodes behind a load balancer, sharing
   one snapshot store (the same `.hyper-sessions` directory).

   1. Round-robin: a page's requests are spread over both nodes. Expected to
      break: two nodes serve one session at once and diverge.
   2. Sticky (by cookie): a browser stays on its node. Its node is killed
      mid-session; the balancer moves the browser to the other node, which
      restores the session from the shared snapshot.
   3. The built-in router of src/cluster.ts: sessions are routed by the node
      in their id. The worker holding the session is killed right after
      answering a click; the router sends the session to an heir, which has
      the click, and a replacement worker starts. Then the heir is killed
      with a click in flight, which the page retries on the next heir.

   Usage: node tools/cluster/cluster-check.mjs */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const app = join(root, 'examples', 'dispatch')
const NODES = [3101, 3102]
const PORT = 3300
const base = `http://localhost:${PORT}`

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}
const finding = (name, detail) => console.log(`NOTE ${name} (${detail})`)

mkdirSync(join(root, 'output'), { recursive: true })

const startNode = port => {
  const log = openSync(join(root, 'output', `cluster-node-${port}.log`), 'w')
  return spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: app,
    env: { ...process.env, ...secrets, PORT: String(port), NODE_ENV: 'production' },
    stdio: ['ignore', log, log],
  })
}

const stopNode = node => {
  if (node.exitCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(node.pid), '/T', '/F'], { stdio: 'ignore' })
  else node.kill('SIGKILL')
}

/** Kills whatever process listens on `port`. */
const killPort = port => {
  if (process.platform === 'win32') {
    spawnSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -Confirm:$false }`], { stdio: 'ignore' })
  } else {
    spawnSync('sh', ['-c', `kill -9 $(lsof -t -i:${port}) 2>/dev/null`], { stdio: 'ignore' })
  }
}

const waitFor = async port => {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      if ((await fetch(`http://localhost:${port}/greeter`)).ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`node on ${port} did not start`)
}

const signIn = async (browser, name) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(`${base}/`)
  await page.getByLabel('Name').fill(name)
  const stream = page.waitForRequest(request => request.url().includes('/stream'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await stream
  return { context, page, errors }
}

const selected = page =>
  page.locator('[aria-pressed="true"][id^="row-"]').getAttribute('id').catch(() => null)

const clickAndConfirm = async (page, id) => {
  await page.locator(`#row-${id}`).click()
  return page
    .waitForFunction(rowId => document.querySelector(`#row-${rowId}`)?.getAttribute('aria-pressed') === 'true', id, { timeout: 2500 })
    .then(() => true)
    .catch(() => false)
}

rmSync(join(app, '.hyper-sessions'), { recursive: true, force: true })
const nodes = NODES.map(startNode)
await Promise.all(NODES.map(waitFor))
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })

try {
  // ── 1. Round-robin ──────────────────────────────────────────────────────
  {
    const balancer = startBalancer({ port: PORT, upstreams: NODES, mode: 'round-robin' })
    const { context, page } = await signIn(browser, 'Dispatcher RR')
    await page.waitForTimeout(1500)
    const rows = ['INC-101', 'INC-102', 'INC-103', 'INC-104', 'INC-105', 'INC-106']
    let confirmed = 0
    for (const id of rows) if (await clickAndConfirm(page, id)) confirmed += 1
    finding(
      'round-robin: clicks that showed on the page',
      `${confirmed}/${rows.length}; requests per node ${balancer.counts.join(' / ')}`,
    )
    check('round-robin breaks sessions, as expected (two nodes serve one session)', confirmed < rows.length)
    await context.close()
    await balancer.close()
  }

  // ── 2. Sticky, with failover ────────────────────────────────────────────
  {
    const balancer = startBalancer({ port: PORT, upstreams: NODES, mode: 'sticky' })
    const { context, page, errors } = await signIn(browser, 'Dispatcher S')
    const pinned = Number((await context.cookies()).find(cookie => cookie.name === 'lb')?.value)
    check('sticky: the browser is pinned to one node', Number.isInteger(pinned), `node ${NODES[pinned]}`)

    const clicks = ['INC-102', 'INC-104', 'INC-103']
    let confirmed = 0
    for (const id of clicks) if (await clickAndConfirm(page, id)) confirmed += 1
    check('sticky: every click shows on the page', confirmed === clicks.length, `${confirmed}/${clicks.length}`)

    await page.getByLabel('What happened?').pressSequentially('Half-written on node A', { delay: 15 })
    await page.waitForTimeout(1700) // debounced post + snapshot debounce

    const reconnected = page.waitForRequest(request => request.url().includes('/stream'), { timeout: 30000 }).then(() => true).catch(() => false)
    stopNode(nodes[pinned])
    check('sticky: after its node dies, the page reconnects through the balancer', await reconnected)
    await page.waitForTimeout(1500)
    const repinned = Number((await context.cookies()).find(cookie => cookie.name === 'lb')?.value)
    check('sticky: the browser now sticks to the surviving node', repinned !== pinned, `node ${NODES[repinned]}`)
    check('sticky: the selection survived on the other node', (await selected(page)) === 'row-INC-103', await selected(page))
    check(
      'sticky: the half-typed draft survived on the other node',
      (await page.getByLabel('What happened?').inputValue()) === 'Half-written on node A',
    )
    check('sticky: the restored session keeps working', await clickAndConfirm(page, 'INC-105'))
    check('sticky: no page errors', errors.length === 0, errors.slice(0, 2).join(' | '))
    finding('sticky: requests per node', balancer.counts.join(' / '))
    await context.close()
    await balancer.close()
  }

  // ── 3. The built-in router (src/cluster.ts), routing per session ────────
  {
    nodes.forEach(stopNode)
    const primary = spawn(process.execPath, ['--import', 'tsx', 'src/cluster.ts'], {
      cwd: app,
      env: { ...process.env, ...secrets, PORT: String(PORT), WORKERS: '2', NODE_ENV: 'production', HYPER_METRICS: '1' },
      stdio: ['ignore', openSync(join(root, 'output', 'cluster-router.log'), 'w'), openSync(join(root, 'output', 'cluster-router.log'), 'a')],
    })
    try {
      await waitFor(PORT)
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const metrics = await fetch(`${base}/_hyper/metrics`).then(response => response.json()).catch(() => ({}))
        if (metrics.processes === 3) break
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      const { context, page, errors } = await signIn(browser, 'Dispatcher R')
      const endpoint = await page.evaluate(() =>
        document.querySelector('#hyper-control')?.getAttribute('data-signals:_he'),
      )
      const node = endpoint?.match(/\/s\/([a-z0-9]+)\./)?.[1]
      const workers = await (await fetch(`${base}/_hyper/cluster`)).json()
      const owner = workers.find(worker => worker.node === node)
      check('router: the session id names its worker', owner !== undefined, `${node} on :${owner?.port}`)

      await clickAndConfirm(page, 'INC-103')
      await page.getByLabel('What happened?').pressSequentially('Typed before the crash', { delay: 15 })

      // Lossless failover: the worker dies right after answering a click (no
      // quiet second for a snapshot). The click carries the unsent draft.
      const clickToken = Buffer.from(JSON.stringify({ _tag: 'ClickedIncident', id: 'INC-105' })).toString('base64url')
      const answered = page.waitForResponse(
        response => response.request().method() === 'POST' && (response.request().postData() ?? '').includes(clickToken),
      )
      await page.locator('#row-INC-105').click()
      check('router: the click is answered', (await answered).status() === 204)
      let reconnected = page.waitForRequest(request => request.url().includes('/stream'), { timeout: 30000 }).then(() => true).catch(() => false)
      // On Windows the primary owns the workers' listening sockets, so kill
      // the worker process itself.
      process.kill(owner.pid, 'SIGKILL')
      check('router: after its worker dies, the page reconnects', await reconnected)
      await page.waitForTimeout(1500)
      check('router: the click answered just before the crash survived', (await selected(page)) === 'row-INC-105', await selected(page))
      check(
        'router: the half-typed draft is still in its input',
        (await page.getByLabel('What happened?').inputValue()) === 'Typed before the crash',
      )
      check('router: the session keeps working on the survivor', await clickAndConfirm(page, 'INC-104'))
      let replaced = false
      let heir
      for (let attempt = 0; attempt < 60 && !replaced; attempt += 1) {
        const now = await (await fetch(`${base}/_hyper/cluster`)).json()
        replaced = now.length === 2 && !now.some(worker => worker.node === node)
        heir = now.find(worker => worker.heirOf.includes(node))
        if (!replaced) await new Promise(resolve => setTimeout(resolve, 500))
      }
      check('router: a replacement worker started under a new name', replaced)
      check('router: the session stays with its heir after the replacement started', (await selected(page)) === 'row-INC-104' && await clickAndConfirm(page, 'INC-102'), heir?.node)

      // The heir dies while a click is in flight: unanswered, so the page
      // retries it on the next heir.
      let failedPosts = 0
      page.on('requestfailed', request => {
        if (request.method() === 'POST') failedPosts += 1
      })
      reconnected = page.waitForRequest(request => request.url().includes('/stream'), { timeout: 30000 }).then(() => true).catch(() => false)
      await page.locator('#row-INC-106').click()
      process.kill(heir.pid, 'SIGKILL')
      check('router: after the heir dies too, the page reconnects', await reconnected)
      await page
        .waitForFunction(() => document.querySelector('#row-INC-106')?.getAttribute('aria-pressed') === 'true', null, { timeout: 15000 })
        .catch(() => {})
      finding('router: event requests that failed in the second crash (and were retried)', String(failedPosts))
      check('router: the click in flight during the crash was retried and applied', (await selected(page)) === 'row-INC-106', await selected(page))
      // Once the replacement is up (it compiles on start and takes the CPU).
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const now = await (await fetch(`${base}/_hyper/cluster`)).json()
        if (now.length === 2 && !now.some(worker => worker.node === heir.node)) break
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      check('router: the session keeps working on the next heir', await clickAndConfirm(page, 'INC-101'), await selected(page))
      check('router: no page errors', errors.length === 0, errors.slice(0, 2).join(' | '))
      await context.close()
    } finally {
      stopNode(primary)
      for (const port of [PORT + 1, PORT + 2]) killPort(port)
    }
  }
} finally {
  await browser.close()
  nodes.forEach(stopNode)
}

const failed = results.filter(result => !result.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
