import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

/* Browser check for the Dispatch demo. Drives the running server (npm start)
   with two dispatchers in separate browser contexts.
   Usage: node scripts/dispatch-check.mjs [outDir] [maxPostLatencyMs]
   Event POSTs get a random delay up to maxPostLatencyMs so requests overtake
   each other, which exercises the ordered event intake. */

const out = process.argv[2] ?? 'output/dispatch-check'
const maxLatency = Number(process.argv[3] ?? 0)
const base = process.env.URL ?? 'http://localhost:3000'
mkdirSync(out, { recursive: true })

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })

const openDispatcher = async name => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    // A proxy with a self-signed certificate (tools/net/nginx.sh).
    ignoreHTTPSErrors: process.env.IGNORE_HTTPS_ERRORS === '1',
  })
  // CSP violations must fail the console check, whatever they block.
  await context.addInitScript(() =>
    document.addEventListener('securitypolicyviolation', event =>
      console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`),
    ),
  )
  const page = await context.newPage()
  const errors = []
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', error => errors.push(String(error)))
  const posts = []
  page.on('request', request => { if (request.method() === 'POST') posts.push(request.postData()) })
  await page.route('**/_hyper/**', async route => {
    if (route.request().method() === 'POST' && maxLatency > 0) {
      await new Promise(resolve => setTimeout(resolve, Math.random() * maxLatency))
    }
    await route.continue()
  })
  return { name, context, page, errors, posts }
}

const waitForStream = page => page.waitForRequest(request => request.url().includes('/stream'))

/** Opens `path`, gets sent to the sign-in page, signs in and lands back. */
const signIn = async (dispatcher, path = '/') => {
  const response = await dispatcher.page.goto(`${base}${path}`)
  const redirected = new URL(dispatcher.page.url()).pathname === '/login'
  await dispatcher.page.getByLabel('Name').fill(`Dispatcher ${dispatcher.name}`)
  const stream = waitForStream(dispatcher.page)
  const board = dispatcher.page.waitForResponse(r => new URL(r.url()).pathname === path && r.request().method() === 'GET')
  await dispatcher.page.getByRole('button', { name: 'Sign in' }).click()
  const landed = await board
  await stream
  return { redirected, firstStatus: response?.status(), csp: landed.headers()['content-security-policy'] ?? '' }
}

const selectedId = page =>
  page.locator('[aria-pressed="true"][id^="row-"]').getAttribute('id').catch(() => null)

console.log(`simulated POST latency: 0-${maxLatency} ms`)

// ── Dispatcher A opens the board ──────────────────────────────────────────
const a = await openDispatcher('A')
const signedInA = await signIn(a)
check('signed-out visit goes to the sign-in page and back', signedInA.redirected && new URL(a.page.url()).pathname === '/')
check('the board is served with a nonce-based Content-Security-Policy', /script-src 'self' 'nonce-[^']+' 'unsafe-eval'/.test(signedInA.csp))
await a.page.locator('incident-map canvas.maplibregl-canvas').waitFor({ timeout: 15000 })
await a.page.waitForFunction(() => document.querySelector('[data-slot="map"]')?.getAttribute('data-map-state') === 'ready', null, { timeout: 15000 }).catch(() => {})
const mapState = await a.page.locator('[data-slot="map"]').getAttribute('data-map-state')
check('map island boots (crease map + MapLibre in a Foldkit island)', mapState === 'ready', `state=${mapState}`)

// Tag the map canvas: if a morph ever rebuilt the island, the tag would vanish.
await a.page.evaluate(() => {
  document.querySelector('incident-map canvas').dataset.survivor = 'yes'
})

// ── island → server: clicking a marker selects the incident on the server
await a.page.locator('[data-map-marker-id="INC-104"]').click()
await a.page.waitForFunction(() => document.querySelector('#row-INC-104')?.getAttribute('aria-pressed') === 'true', null, { timeout: 5000 })
const panelTitle = await a.page.locator('main').getByText('Street lamp flickering near Gärtnerplatz').count()
check('marker click (island event) selects the incident on the server', panelTitle >= 2, `selected=${await selectedId(a.page)}`)

// ── server → island: selecting in the list highlights and focuses the marker
await a.page.locator('#row-INC-103').click()
await a.page.waitForFunction(
  () => document.querySelector('[data-map-marker-id="INC-103"] span')?.className.includes('ring-4'),
  null,
  { timeout: 5000 },
)
const focused = await a.page.locator('[data-slot="map"]').getAttribute('data-map-config')
check('list click selects on the server; the island highlights and focuses the marker', focused.includes('11.5935'))

// ── server-side Submodel: crease toggle-group filter ─────────────────────
await a.page.getByRole('button', { name: 'Open', exact: true }).click()
await a.page.waitForFunction(() => [...document.querySelectorAll('[id^="row-"]')].every(row => row.textContent.includes('Open')), null, { timeout: 5000 }).catch(() => {})
const openRows = await a.page.locator('[id^="row-"]').count()
const allOpen = await a.page.evaluate(() => [...document.querySelectorAll('[id^="row-"]')].every(row => row.textContent.includes('Open')))
const openMarkers = await a.page.locator('[data-map-marker-id]:not([data-map-marker-id="draft"])').count()
check('toggle-group Submodel filters on the server; island markers follow', allOpen && openRows > 0 && openMarkers === openRows, `rows=${openRows} markers=${openMarkers}`)
await a.page.getByRole('button', { name: 'All', exact: true }).click()
await a.page.waitForFunction(() => document.querySelectorAll('[id^="row-"]').length > 4, null, { timeout: 5000 }).catch(() => {})

// ── Keyboard focus in a server-side Submodel (forwarded FocusTab) ────────
await a.page.getByRole('button', { name: 'All', exact: true }).focus()
await a.page.keyboard.press('ArrowRight')
await a.page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Open', null, { timeout: 5000 }).catch(() => {})
const focusedFilter = await a.page.evaluate(() => document.activeElement?.textContent?.trim())
check('arrow keys move focus in the server-side toggle-group (forwarded FocusTab)', focusedFilter === 'Open', `focused=${focusedFilter}`)
await a.page.keyboard.press('Enter')
await a.page.waitForFunction(() => [...document.querySelectorAll('[id^="row-"]')].every(row => row.textContent.includes('Open')), null, { timeout: 5000 }).catch(() => {})
const keyboardFiltered = await a.page.evaluate(() => [...document.querySelectorAll('[id^="row-"]')].every(row => row.textContent.includes('Open')))
check('Enter on the focused filter selects it', keyboardFiltered)
await a.page.getByRole('button', { name: 'All', exact: true }).click()

// ── debounced search ─────────────────────────────────────────────────────
await a.page.getByLabel('Search incidents').pressSequentially('lamp', { delay: 50 })
await a.page.waitForFunction(() => document.querySelectorAll('[id^="row-"]').length === 1, null, { timeout: 5000 }).catch(() => {})
check('search filters on the server', (await a.page.locator('[id^="row-"]').count()) === 1)
await a.page.getByLabel('Search incidents').fill('')
await a.page.getByLabel('Search incidents').press('Space')
await a.page.getByLabel('Search incidents').press('Backspace')
await a.page.waitForFunction(() => document.querySelectorAll('[id^="row-"]').length === 7, null, { timeout: 5000 }).catch(() => {})

// ── Schema validation on the server ──────────────────────────────────────
await a.page.getByRole('button', { name: 'Report', exact: true }).click()
await a.page.getByText('Describe the incident in at least 4 characters.').waitFor({ timeout: 5000 }).catch(() => {})
const titleError = await a.page.getByText('Describe the incident in at least 4 characters.').count()
const locationError = await a.page.getByText('Click the map to place the incident.').count()
check('empty report shows Schema errors for title and location', titleError === 1 && locationError === 1)

// ── Report: type, pick a location on the map, press Enter right away ─────
const title = `Burst pipe flooding underpass ${Date.now() % 10000}`
await a.page.getByLabel('What happened?').pressSequentially(title, { delay: 15 })
const box = await a.page.locator('incident-map canvas').boundingBox()
// Find a spot on the map itself, well away from every marker (their overlays
// are re-projected asynchronously after the map moves, so let it settle).
await a.page.waitForTimeout(500)
const spot = await a.page.evaluate(({ x, y, width, height }) => {
  const markers = [...document.querySelectorAll('[data-map-marker-id]')].map(marker => {
    const rect = marker.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })
  let best = { x: x + width / 2, y: y + height / 2, distance: -1 }
  for (let fx = 0.15; fx <= 0.85; fx += 0.05) {
    for (let fy = 0.2; fy <= 0.8; fy += 0.05) {
      const point = { x: x + width * fx, y: y + height * fy }
      const distance = Math.min(...markers.map(marker => Math.hypot(marker.x - point.x, marker.y - point.y)), 9999)
      if (distance > best.distance) best = { ...point, distance }
    }
  }
  return best
}, box)
const postsBeforeClick = a.posts.length
await a.page.mouse.click(spot.x, spot.y)
await a.page.waitForFunction(() => document.querySelector('[data-map-marker-id="draft"]') !== null, null, { timeout: 5000 }).catch(() => {})
const hasDraft = (await a.page.locator('[data-map-marker-id="draft"]').count()) === 1
const clickDiagnostics = hasDraft ? '' : `spot=${JSON.stringify(spot)} posts=${a.posts.slice(postsBeforeClick).join(' ; ')} map=${await a.page.locator('[data-slot="map"]').getAttribute('data-map-state')}`
check('map click (island event) sets the draft location; the island shows the draft pin', hasDraft, clickDiagnostics)
// Enter immediately after typing: the debounced title and the submit race.
await a.page.getByLabel('What happened?').press('End')
await a.page.getByLabel('What happened?').pressSequentially('!', { delay: 0 })
await a.page.getByLabel('What happened?').press('Enter')
const reported = a.page.locator('[id^="row-"]', { hasText: title })
await reported.waitFor({ timeout: 8000 }).catch(() => {})
const newRow = (await reported.textContent().catch(() => '')) ?? ''
const newRowId = await reported.getAttribute('id').catch(() => null)
const formState = newRow === '' ? await a.page.locator('form').filter({ hasText: 'Severity' }).textContent() : ''
if (newRow === '') await a.page.screenshot({ path: `${out}/report-failed.png` })
check('report submitted with the latest title despite the race (ordered events)', newRow.includes(`${title}!`), newRow === '' ? `form: ${formState?.slice(0, 160)}` : newRow.slice(0, 80))
if (newRowId !== null) await a.page.waitForFunction(id => document.getElementById(id)?.getAttribute('aria-pressed') === 'true', newRowId, { timeout: 5000 }).catch(() => {})
await a.page.waitForFunction(() => document.querySelector('#draft-title')?.value === '', null, { timeout: 3000 }).catch(() => {})
const selectedAfterReport = await selectedId(a.page)
const titleAfterReport = await a.page.getByLabel('What happened?').inputValue()
check(
  'new incident is selected and the form is cleared',
  newRowId !== null && selectedAfterReport === newRowId && titleAfterReport === '',
  `selected=${selectedAfterReport} expected=${newRowId} title=${JSON.stringify(titleAfterReport)}`,
)
await a.page.screenshot({ path: `${out}/board-a.png` })

// ── Dispatcher B: presence and live updates across sessions ─────────────
const b = await openDispatcher('B')
await signIn(b)
await a.page.waitForFunction(() => document.querySelectorAll('header [data-slot="badge"]').length === 2, null, { timeout: 5000 }).catch(() => {})
check('presence: A sees two dispatchers on duty', (await a.page.locator('header [data-slot="badge"]').count()) === 2)

const target = newRowId?.replace('row-', '') ?? 'INC-101'
await b.page.locator(`#row-${target}`).click()
await b.page.getByRole('button', { name: 'Take it' }).click()
await a.page.waitForFunction(id => document.querySelector(`#row-${id}`)?.textContent?.includes('Assigned'), target, { timeout: 5000 }).catch(() => {})
const rowA = await a.page.locator(`#row-${target}`).textContent()
const rowB = await b.page.locator(`#row-${target}`).textContent()
check("live: B takes the new incident and A's board updates without reload", rowA.includes('Assigned'), `A: ${rowA.slice(0, 60)} | B: ${rowB.slice(0, 60)} | B posts: ${b.posts.join(' ; ')}`)

// ── Detail page: comments flow back to the board ─────────────────────────
await b.page.goto(`${base}/incidents/${target}`)
await b.page.getByLabel(/Comment as/).fill('Crew on site, ETA 10 minutes')
await b.page.getByLabel(/Comment as/).press('Space')
await b.page.waitForTimeout(400 + maxLatency)
await b.page.getByRole('button', { name: 'Post comment' }).click()
await b.page.getByText('Crew on site, ETA 10 minutes').waitFor({ timeout: 5000 }).catch(() => {})
check('detail page posts a comment', (await b.page.getByText('Crew on site, ETA 10 minutes').count()) === 1)
await a.page.waitForFunction(id => document.querySelector(`#row-${id}`)?.textContent?.includes('1 comments'), target, { timeout: 5000 }).catch(() => {})
check('board shows the comment count and activity live', (await a.page.locator(`#row-${target}`).textContent()).includes('1 comments'))
await b.page.screenshot({ path: `${out}/incident-b.png` })

// ── The island survived every morph ─────────────────────────────────────
const survivor = await a.page.evaluate(() => document.querySelector('incident-map canvas')?.dataset.survivor)
check('the map island was never rebuilt by a morph', survivor === 'yes')

// ── Pending indicator under latency ──────────────────────────────────────
if (maxLatency > 0) {
  const sawPending = a.page.waitForFunction(() => document.documentElement.hasAttribute('data-hyper-pending'), null, { timeout: 3000 }).then(() => true).catch(() => false)
  await a.page.locator('#row-INC-102').click()
  check('pending indicator while an event is in flight', await sawPending)
}

const unknown = await a.page.goto(`${base}/incidents/INC-999`)
check('unknown incident answers 404', unknown?.status() === 404)

// ── Signing out ends the other tabs' sessions ────────────────────────────
const otherTab = await b.context.newPage()
const otherStream = waitForStream(otherTab)
await otherTab.goto(`${base}/`)
await otherStream
await b.page.goto(`${base}/`)
await b.page.getByRole('button', { name: 'Sign out' }).click()
await b.page.waitForURL(/\/login/, { timeout: 5000 }).catch(() => {})
check('sign out leads to the sign-in page', new URL(b.page.url()).pathname === '/login')
// The other tab's next event finds its session bound to a signed-out user:
// the page reloads and its Flags send it to sign in.
await otherTab.locator('#row-INC-102').click()
await otherTab.waitForURL(/\/login/, { timeout: 5000 }).catch(() => {})
check("the other tab's next event sends it to sign in", new URL(otherTab.url()).pathname === '/login', otherTab.url())

for (const dispatcher of [a, b]) {
  const relevant = dispatcher.errors.filter(
    error => /CSP violation|Content Security Policy/.test(error) || !/tiles|Failed to load resource/.test(error),
  )
  check(`no console errors (${dispatcher.name})`, relevant.length === 0, relevant.slice(0, 2).join(' | '))
}

await browser.close()
const failed = results.filter(result => !result.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
