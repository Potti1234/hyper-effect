import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { startBalancer } from './balancer.mjs'

/* Phase B5: two catalog admin processes on one Postgres (products, images
   and session snapshots), as two machines would run it.

   1. A change saved on one process reaches a list open on the other, through
      LISTEN/NOTIFY.
   2. An image uploaded on one is served by the other.
   3. An edit conflict is detected across processes (the revision check is in
      the database), and a taken SKU is refused (a unique constraint).
   4. Behind a sticky balancer, the process holding an editor's session is
      killed mid-edit; the page continues on the other process, from the
      snapshot in Postgres, and saves.

   Usage: node tools/cluster/admin-nodes-check.mjs (needs Docker for Postgres) */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const app = join(root, 'examples', 'admin')
const NODES = [
  { name: 'a', port: 3201 },
  { name: 'b', port: 3202 },
]
const BALANCER = 3300

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const databaseUrl = spawnSync('bash', [join(root, 'tools/postgres/start.sh')], { encoding: 'utf8' }).stdout.trim()
if (!databaseUrl.startsWith('postgres://')) throw new Error('Postgres did not start (is Docker running?)')
spawnSync('docker', ['exec', 'hyper-postgres', 'psql', '-q', '-U', 'hyper', '-d', 'hyper', '-c',
  'DROP TABLE IF EXISTS products, images, hyper_snapshots; DROP SEQUENCE IF EXISTS product_ids;'])
const snapshotRows = () =>
  Number(spawnSync('docker', ['exec', 'hyper-postgres', 'psql', '-tA', '-U', 'hyper', '-d', 'hyper', '-c',
    'SELECT COUNT(*) FROM hyper_snapshots'], { encoding: 'utf8' }).stdout.trim())

mkdirSync(join(root, 'output'), { recursive: true })
spawnSync('npm run css', { cwd: app, shell: true, stdio: 'ignore' })

const startNode = ({ name, port }) => {
  const log = openSync(join(root, 'output', `admin-node-${name}.log`), 'w')
  return spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: app,
    env: { ...process.env, PORT: String(port), HYPER_NODE: name, DATABASE_URL: databaseUrl, NODE_ENV: 'production' },
    stdio: ['ignore', log, log],
  })
}
const stopNode = node => {
  if (node.exitCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(node.pid), '/T', '/F'], { stdio: 'ignore' })
  else node.kill('SIGKILL')
}
const waitFor = async port => {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      if ((await fetch(`http://localhost:${port}/login`)).ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`admin on ${port} did not start`)
}

// One process first, so the other finds the catalog seeded.
const processes = [startNode(NODES[0])]
await waitFor(NODES[0].port)
processes.push(startNode(NODES[1]))
await waitFor(NODES[1].port)
const browser = await chromium.launch()

const signIn = async (base, name = 'ada') => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(`${base}/products`)
  await page.getByLabel('User').fill(name)
  const stream = page.waitForRequest(request => request.url().includes('/stream'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/products/)
  await stream
  return { context, page, errors }
}
const until = (page, predicate, arg, timeout = 5000) =>
  page.waitForFunction(predicate, arg, { timeout }).then(() => true).catch(() => false)
const openEditor = async (user, base, id) => {
  const stream = user.page.waitForRequest(request => request.url().includes('/stream'))
  await user.page.goto(`${base}/products/${id}`)
  await stream
  await user.page.waitForTimeout(300)
}

let balancer
try {
  const [a, b] = NODES.map(node => `http://localhost:${node.port}`)
  const onA = await signIn(a)
  const onB = await signIn(b)
  const summary = await onA.page.locator('#pager span').first().textContent()
  check('both processes serve the seeded catalog from Postgres', summary === '1–20 of 240 products', summary)

  // ── 1. Live across processes ─────────────────────────────────────────────
  await onA.page.goto(`${a}/products?sort=name`)
  await until(onA.page, () => document.querySelector('#pager span') !== null)
  const target = (await onA.page.locator('#results tbody tr td:first-child a').first().getAttribute('href')).split('/').pop()
  await openEditor(onB, b, target)
  await onB.page.getByLabel('Name').fill('Aaa renamed on node b')
  await onB.page.getByRole('button', { name: 'Save changes' }).click()
  await until(onB.page, () => document.querySelector('#actions')?.textContent?.includes('Saved'))
  const reached = await until(
    onA.page,
    id => document.querySelector(`#product-${id}`)?.textContent?.includes('Aaa renamed on node b'),
    target,
  )
  check('a save on process b shows live in a list on process a (LISTEN/NOTIFY)', reached)

  // ── 2. Images across processes ───────────────────────────────────────────
  await onB.page.locator('#image-file').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PNG })
  await until(onB.page, () => document.querySelector('#image-panel img') !== null)
  const src = await onB.page.locator('#image-panel img').getAttribute('src')
  const served = await onA.context.request.get(`${a}${src}`)
  check('an image uploaded on b is served by a', served.status() === 200 && served.headers()['content-type'] === 'image/png', `${served.status()}`)

  // ── 3. Edit conflict across processes ────────────────────────────────────
  await openEditor(onA, a, target)
  await openEditor(onB, b, target)
  await onB.page.getByLabel('Stock').fill('99')
  await onB.page.getByRole('button', { name: 'Save changes' }).click()
  await until(onB.page, () => document.querySelector('#actions')?.textContent?.includes('Saved'))
  await onA.page.getByLabel('Stock').fill('7')
  await onA.page.getByRole('button', { name: 'Save changes' }).click()
  const conflict = await until(onA.page, () => (document.querySelector('#conflict')?.textContent ?? '').length > 0)
  check('a stale save on a is refused after b saved (revision check in Postgres)', conflict)

  // ── A taken SKU is the database's unique constraint ──────────────────────
  await openEditor(onA, a, target)
  await onA.page.getByLabel('SKU').fill('TLS-1000')
  await onA.page.getByRole('button', { name: 'Save changes' }).click()
  const taken = await until(onA.page, () => document.querySelector('#product-form')?.textContent?.includes('TLS-1000 is already used'))
  check('a SKU another product has is refused (unique constraint)', taken)

  // ── 4. Failover behind a sticky balancer ─────────────────────────────────
  balancer = startBalancer({ port: BALANCER, upstreams: NODES.map(node => node.port), mode: 'sticky' })
  const base = `http://localhost:${BALANCER}`
  const editor = await signIn(base)
  const pinned = Number((await editor.context.cookies()).find(cookie => cookie.name === 'lb')?.value)
  await openEditor(editor, base, 'P0010')
  const typed = editor.page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/_hyper/'))
  await editor.page.getByLabel('Name').fill('Saved after the failover')
  check('the typed name is answered by the pinned process', (await typed).status() === 204, `process ${NODES[pinned].name}`)
  check('the session snapshot is in Postgres', snapshotRows() > 0, `${snapshotRows()} rows`)
  const reconnected = editor.page.waitForRequest(request => request.url().includes('/stream'), { timeout: 30000 }).then(() => true, () => false)
  stopNode(processes[pinned])
  check('after its process dies, the page reconnects through the balancer', await reconnected)
  await editor.page.waitForTimeout(1000)
  await editor.page.getByRole('button', { name: 'Save changes' }).click()
  const saved = await until(editor.page, () => document.querySelector('h1')?.textContent === 'Saved after the failover', null, 10000)
  check('the other process continues the session and saves the typed name', saved, await editor.page.locator('h1').textContent())
  check('no page errors', [onA, onB, editor].every(user => user.errors.length === 0), [onA, onB, editor].flatMap(user => user.errors).slice(0, 2).join(' | '))
} finally {
  await browser.close()
  await balancer?.close()
  processes.forEach(stopNode)
}

const failed = results.filter(result => !result.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
