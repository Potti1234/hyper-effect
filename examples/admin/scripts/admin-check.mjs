import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

/* Browser check for the catalog admin. Drives a running server (npm start)
   with two editors and a viewer in separate browser contexts.
   Usage: node scripts/admin-check.mjs [outDir] [maxPostLatencyMs] */

const out = process.argv[2] ?? 'output/admin-check'
const maxLatency = Number(process.argv[3] ?? 0)
const base = process.env.URL ?? 'http://localhost:3200'
mkdirSync(out, { recursive: true })

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}

// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const browser = await chromium.launch()

const openUser = async (label, name) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
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
  await page.route('**/_hyper/**', async route => {
    if (route.request().method() === 'POST' && maxLatency > 0) {
      await new Promise(resolve => setTimeout(resolve, Math.random() * maxLatency))
    }
    await route.continue()
  })
  const user = { label, name, context, page, errors }
  await page.goto(`${base}/products`)
  const redirected = new URL(page.url()).pathname === '/login'
  await page.getByLabel('User').fill(name)
  const stream = page.waitForRequest(request => request.url().includes('/stream'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/products/)
  await stream
  return { ...user, redirected }
}

const waitForStream = page => page.waitForRequest(request => request.url().includes('/stream'))
const summary = page => page.locator('#pager span').first().textContent()
const rowNames = page => page.locator('#results tbody tr td:first-child').allTextContents()
const prices = async page =>
  (await page.locator('#results tbody tr td:nth-child(4)').allTextContents()).map(text => Number(text.replace(/[^0-9.]/g, '')))
const until = (page, predicate, arg) =>
  page.waitForFunction(predicate, arg, { timeout: 5000 }).then(() => true).catch(() => false)

console.log(`simulated POST latency: 0-${maxLatency} ms`)

// ── Editor A: the list ────────────────────────────────────────────────────
const a = await openUser('A', 'ada')
check('signed-out visit goes to sign-in and back to the list', a.redirected && new URL(a.page.url()).pathname === '/products')
check('the list shows the first page', (await summary(a.page)) === '1–20 of 240 products', await summary(a.page))

const firstPage = await rowNames(a.page)
await a.page.getByRole('button', { name: 'Go to page 2' }).click()
await until(a.page, () => document.querySelector('#pager span')?.textContent?.startsWith('21–40'))
check('pagination moves to page 2 in-page', (await summary(a.page)).startsWith('21–40') && (await rowNames(a.page))[0] !== firstPage[0])
check('the page number is in the URL', new URL(a.page.url()).searchParams.get('page') === '2', a.page.url())

await a.page.getByLabel('Search').pressSequentially('hammer', { delay: 30 })
await until(a.page, () => document.querySelector('#pager span')?.textContent?.includes('of 6 products'))
check('search filters as you type and resets to page 1', (await summary(a.page)) === '1–6 of 6 products', await summary(a.page))
check('the search is in the URL', new URL(a.page.url()).searchParams.get('q') === 'hammer' && !new URL(a.page.url()).searchParams.has('page'), a.page.url())

await a.page.getByLabel('Search').fill('')
await a.page.getByLabel('Search').press('Backspace')
await until(a.page, () => document.querySelector('#pager span')?.textContent?.includes('of 240'))
await a.page.getByLabel('Category').selectOption('Kitchen')
await until(a.page, () => document.querySelector('#pager span')?.textContent?.includes('of 40 products'))
await a.page.getByRole('button', { name: 'Sort by price' }).click()
// The arrow shows once the sorted page is on screen.
await until(a.page, () => document.querySelector('#results thead')?.textContent?.includes('Price ↑'))
const sorted = await prices(a.page)
check('category filter and sort by price work together', (await summary(a.page)).includes('of 40') && sorted.every((value, index) => index === 0 || sorted[index - 1] <= value), `${await summary(a.page)} ${sorted.slice(0, 4)}`)

const listUrl = a.page.url()
const reloaded = waitForStream(a.page)
await a.page.reload()
await reloaded
check('a reload restores filters and sort from the URL', (await a.page.getByLabel('Category').inputValue()) === 'Kitchen' && (await summary(a.page)).includes('of 40'), listUrl)

// ── Editor B watches the list while A edits ───────────────────────────────
const b = await openUser('B', 'ada')
await b.page.goto(`${base}/products?category=Kitchen&sort=price&dir=asc`)
await waitForStream(b.page)

const target = await a.page.locator('#results tbody tr td:first-child a').first().getAttribute('href')
const targetId = target.split('/').pop()
const editing = waitForStream(a.page)
await a.page.goto(`${base}${target}`)
await editing

await a.page.getByLabel('Name').fill('')
await a.page.getByLabel('Price (EUR)').fill('abc')
await a.page.getByRole('button', { name: 'Save changes' }).click()
await until(a.page, () => document.querySelector('#name')?.getAttribute('aria-invalid') === 'true')
const errorsShown = await a.page.locator('#product-form').textContent()
check('invalid input shows Schema errors next to the fields', errorsShown.includes('At least 2 characters.') && errorsShown.includes('A price like 12.50.'))

await a.page.getByLabel('Name').fill('Renamed by the check')
await a.page.getByLabel('Price (EUR)').fill('1.00')
await a.page.waitForTimeout(300 + maxLatency)
await a.page.getByRole('button', { name: 'Save changes' }).click()
await until(a.page, () => document.querySelector('#actions')?.textContent?.includes('Saved'))
check('saving updates the product', (await a.page.locator('#actions').textContent()).includes('Saved') && (await a.page.locator('h1').textContent()) === 'Renamed by the check')
await until(b.page, id => document.querySelector(`#product-${id}`)?.textContent?.includes('Renamed by the check'), targetId)
check("B's list shows the change live", (await b.page.locator(`#product-${targetId}`).textContent()).includes('Renamed by the check'))

// ── Uploads ───────────────────────────────────────────────────────────────
await a.page.locator('#image-file').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PNG })
await until(a.page, () => document.querySelector('#image-panel img')?.complete && document.querySelector('#image-panel img').naturalWidth > 0)
const firstImage = await a.page.locator('#image-panel img').getAttribute('src')
check('a chosen image is uploaded and shown', firstImage?.startsWith('/images/') === true, firstImage)

await a.page.locator('#image-file').setInputFiles({ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('not an image') })
await until(a.page, () => document.querySelector('#image-panel [role="alert"]') !== null)
check('a file that is not an image is refused', (await a.page.locator('#image-panel').textContent()).includes('Use a PNG, JPEG, GIF or WebP image.'))

const dropped = await a.page.evaluateHandle(bytes => {
  const transfer = new DataTransfer()
  transfer.items.add(new File([new Uint8Array(bytes)], 'dropped.png', { type: 'image/png' }))
  return transfer
}, [...PNG])
await a.page.locator('#image-drop').dispatchEvent('drop', { dataTransfer: dropped })
await until(a.page, src => { const img = document.querySelector('#image-panel img'); return img && img.getAttribute('src') !== src && img.naturalWidth > 0 }, firstImage)
check('a dropped image is uploaded too', (await a.page.locator('#image-panel img').getAttribute('src')) !== firstImage)
await a.page.screenshot({ path: `${out}/edit-a.png` })

// ── Edit conflict ─────────────────────────────────────────────────────────
const bEditing = waitForStream(b.page)
await b.page.goto(`${base}${target}`)
await bEditing
await a.page.getByLabel('Stock').fill('7')
await b.page.getByLabel('Stock').fill('99')
await b.page.waitForTimeout(300 + maxLatency)
await b.page.getByRole('button', { name: 'Save changes' }).click()
await until(b.page, () => document.querySelector('#actions')?.textContent?.includes('Saved'))
const conflictShown = await until(a.page, () => document.querySelector('#conflict [role="alert"]') !== null)
check("A sees B's save as a conflict while editing", conflictShown)
await a.page.getByRole('button', { name: 'Save changes' }).click()
await a.page.waitForTimeout(500 + maxLatency)
await a.page.getByRole('button', { name: 'Take their version' }).click()
await until(a.page, () => document.querySelector('#stock')?.value === '99')
check("A's save was refused and A continues from B's version", (await a.page.getByLabel('Stock').inputValue()) === '99' && (await a.page.locator('#conflict').textContent()) === '')

// ── Create and delete ─────────────────────────────────────────────────────
const creating = waitForStream(a.page)
await a.page.goto(`${base}/products/new`)
await creating
await a.page.getByLabel('Name').fill('Check-made lantern')
await a.page.getByLabel('SKU').fill('OUT-9001')
await a.page.getByLabel('Category').selectOption('Outdoor')
await a.page.getByLabel('Price (EUR)').fill('19.90')
await a.page.waitForTimeout(300 + maxLatency)
await a.page.getByRole('button', { name: 'Create product' }).click()
await a.page.waitForURL(/\/products\/P\d+$/, { timeout: 5000 }).catch(() => {})
await waitForStream(a.page).catch(() => {})
check('creating a product opens it', /\/products\/P\d+$/.test(a.page.url()) && (await a.page.locator('h1').textContent()) === 'Check-made lantern', a.page.url())

await a.page.getByRole('button', { name: 'Delete…' }).click()
await a.page.getByRole('button', { name: 'Delete', exact: true }).click()
await a.page.waitForURL(/\/products$/, { timeout: 5000 }).catch(() => {})
await waitForStream(a.page).catch(() => {})
await a.page.getByLabel('Search').pressSequentially('OUT-9001', { delay: 20 })
await until(a.page, () => document.querySelector('#results')?.textContent?.includes('No products'))
check('deleting returns to the list, and the product is gone', (await a.page.locator('#results').textContent()).includes('No products'))

// ── Viewer ────────────────────────────────────────────────────────────────
const v = await openUser('V', 'grace')
check('viewers get no "New product"', (await v.page.getByRole('link', { name: 'New product' }).count()) === 0)
const viewing = waitForStream(v.page)
await v.page.goto(`${base}${target}`)
await viewing
check(
  'viewers see the form read-only, without save, upload or delete',
  (await v.page.getByLabel('Name').getAttribute('readonly')) !== null &&
    (await v.page.getByRole('button', { name: 'Save changes' }).count()) === 0 &&
    (await v.page.locator('#image-file').count()) === 0 &&
    (await v.page.getByRole('button', { name: 'Delete…' }).count()) === 0,
)
const newForViewer = await v.page.goto(`${base}/products/new`)
check('viewers cannot open the create page', newForViewer?.status() === 404)

for (const user of [a, b, v]) {
  const relevant = user.errors.filter(error => !/Failed to load resource/.test(error) || /CSP/.test(error))
  check(`no console errors (${user.label})`, relevant.length === 0, relevant.slice(0, 2).join(' | '))
}

await browser.close()
const failed = results.filter(result => !result.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
