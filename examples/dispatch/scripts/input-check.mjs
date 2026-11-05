import { chromium } from 'playwright'

/* Experiment 4: text input the way people really enter it, on client-owned
   inputs (whose value the morph never writes), against a running server.

   1. IME composition (Japanese, Chinese, Korean input) in the search field,
      while another dispatcher's changes keep morphing the page: the
      composition must not be disturbed, and the committed text must reach
      the server.
   2. Autofill: a value set by script with input and change events, as
      browsers' autofill does, submitted in the same moment.
   3. A fill with a change event only (some password managers, older
      autofill): the value must still reach the server with the submit.

   Usage: node scripts/input-check.mjs   (URL=… for another server) */

const base = process.env.URL ?? 'http://localhost:3000'
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}
const token = value => Buffer.from(JSON.stringify(value)).toString('base64url')

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const open = async name => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(`${base}/`)
  await page.getByLabel('Name').fill(name)
  const stream = page.waitForRequest(request => request.url().includes('/stream'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await stream
  await page.locator('[id^="row-"]').first().waitFor()
  return { page, errors }
}
const rows = page => page.locator('[id^="row-"]').count()

const a = await open('Input A')
const b = await open('Input B')

// B changes shared state every 250 ms, so A's page morphs all the while.
let churning = true
const churn = b.page.evaluate(
  async ({ take, reopen }) => {
    const endpoint = document.querySelector('#hyper-control').getAttribute('data-signals:_he').replace(/^'|'$/g, '')
    for (let q = 1; q <= 400 && !window.stopChurn; q += 1) {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'datastar-request': 'true' },
        body: JSON.stringify({ m: q % 2 ? take : reopen, q, p: {} }),
      })
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  },
  { take: token({ _tag: 'ClickedTakeIncident', id: 'INC-101' }), reopen: token({ _tag: 'ClickedReopenIncident', id: 'INC-101' }) },
)

// ── 1. IME composition in the search field ────────────────────────────────
const search = a.page.getByLabel('Search incidents')
await search.click()
const cdp = await a.page.context().newCDPSession(a.page)
const morphsBefore = await a.page.evaluate(() => (window.__morphs = 0))
await a.page.evaluate(() => {
  new MutationObserver(() => (window.__morphs += 1)).observe(document.body, { subtree: true, childList: true })
})
const seen = []
for (const composing of ['w', 'wa', 'wat', 'wate', 'water']) {
  await cdp.send('Input.imeSetComposition', { text: composing, selectionStart: composing.length, selectionEnd: composing.length })
  await a.page.waitForTimeout(350)
  seen.push(await search.inputValue())
}
const morphsDuring = await a.page.evaluate(() => window.__morphs)
check(
  'the composition is never overwritten while the page morphs',
  seen.join(',') === 'w,wa,wat,wate,water' && morphsDuring > 0,
  `values ${seen.join(',')}, ${morphsDuring} DOM changes meanwhile (from ${morphsBefore})`,
)
await cdp.send('Input.insertText', { text: 'Water' })
await a.page.waitForFunction(() => document.querySelectorAll('[id^="row-"]').length === 1, null, { timeout: 5000 }).catch(() => {})
check(
  'the committed text reaches the server and filters the list',
  (await search.inputValue()) === 'Water' && (await rows(a.page)) === 1 && (await a.page.locator('#row-INC-102').count()) === 1,
  `value=${await search.inputValue()} rows=${await rows(a.page)}`,
)
await search.fill('')
await search.press('Space')
await search.press('Backspace')
await a.page.waitForFunction(() => document.querySelectorAll('[id^="row-"]').length === 7, null, { timeout: 5000 }).catch(() => {})

// ── Shared: place the report's location on the map ────────────────────────
const placeDraft = async page => {
  await page.locator('incident-map canvas.maplibregl-canvas').waitFor({ timeout: 15000 })
  await page.waitForTimeout(800)
  const box = await page.locator('incident-map canvas').boundingBox()
  const spot = await page.evaluate(({ x, y, width, height }) => {
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
  await page.mouse.click(spot.x, spot.y)
  return page
    .waitForFunction(() => document.querySelector('[data-map-marker-id="draft"]') !== null, null, { timeout: 5000 })
    .then(() => true, () => false)
}

/** Fills the report title by script with the given events, and submits in
 *  the same task, so nothing debounced has gone out yet. */
const fillAndSubmit = (page, title, events) =>
  page.evaluate(
    ({ title, events }) => {
      const input = document.querySelector('#draft-title')
      input.value = title
      for (const type of events) input.dispatchEvent(new Event(type, { bubbles: true }))
      input.form.requestSubmit()
    },
    { title, events },
  )
const reported = (page, title) =>
  page.locator('[id^="row-"]', { hasText: title }).waitFor({ timeout: 8000 }).then(() => true, () => false)

// ── 2. Autofill: input and change events, submitted at once ───────────────
check('the map places the report location', await placeDraft(a.page))
const autofilled = `Autofilled report ${Date.now() % 10000}`
await fillAndSubmit(a.page, autofilled, ['input', 'change'])
check('an autofilled title submitted at once is reported', await reported(a.page, autofilled))

// ── 3. A fill with a change event only ────────────────────────────────────
await placeDraft(a.page)
const changeOnly = `Change-only fill ${Date.now() % 10000}`
await fillAndSubmit(a.page, changeOnly, ['change'])
check('a title filled with only a change event is reported', await reported(a.page, changeOnly))

await b.page.evaluate(() => (window.stopChurn = true))
churning = false
await churn.catch(() => {})
check('no page errors', a.errors.length + b.errors.length === 0, [...a.errors, ...b.errors].slice(0, 2).join(' | '))
await browser.close()
void churning

const failed = results.filter(result => !result.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
