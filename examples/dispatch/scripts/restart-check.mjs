import { spawn, spawnSync } from 'node:child_process'
import { chromium } from 'playwright'

/* Restart check: the server is killed and started again while a page is
   open. Datastar reconnects, the session is restored from its snapshot, and
   the page carries on with its UI state (selection, half-typed draft).
   Starts its own server on PORT (default 3100). Usage:
   node scripts/restart-check.mjs */

const port = Number(process.env.PORT ?? 3100)
const base = `http://localhost:${port}`

const startServer = () =>
  spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  })

const stopServer = server => {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    server.kill('SIGKILL')
  }
}

const waitForServer = async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${base}/greeter`)).ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('server did not start')
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}

let server = startServer()
await waitForServer()

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
await page.goto(`${base}/`) // redirects to sign in
await page.getByLabel('Name').fill('Dispatcher R')
const stream = page.waitForRequest(request => request.url().includes('/stream'))
await page.getByRole('button', { name: 'Sign in' }).click()
await stream

await page.locator('#row-INC-103').click()
await page.waitForFunction(() => document.querySelector('#row-INC-103')?.getAttribute('aria-pressed') === 'true')
await page.getByLabel('What happened?').pressSequentially('Half-written report', { delay: 20 })
await page.waitForTimeout(1600) // debounced post + snapshot debounce

stopServer(server)
const reconnect = page
  .waitForRequest(request => request.url().includes('/stream'), { timeout: 30000 })
  .then(() => true)
  .catch(() => false)
await page.waitForTimeout(1000)
server = startServer()
await waitForServer()

// Datastar retries the stream; the restored session sends a full morph.
const reconnected = await reconnect
check('page reconnects to the restarted server', reconnected)
await page.waitForTimeout(1500)

const selected = await page.locator('#row-INC-103').getAttribute('aria-pressed')
check('selection survived the restart (session snapshot)', selected === 'true')
check(
  'half-typed draft survived the restart',
  (await page.getByLabel('What happened?').inputValue()) === 'Half-written report',
)

await page.getByRole('button', { name: 'Take it' }).click()
const assigned = await page
  .waitForFunction(() => document.querySelector('#row-INC-103')?.textContent?.includes('Assigned'), null, { timeout: 5000 })
  .then(() => true)
  .catch(() => false)
check('restored session keeps working', assigned)

await browser.close()
stopServer(server)
const failed = results.filter(ok => !ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
