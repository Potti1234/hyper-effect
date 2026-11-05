import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

/* Browser check for the spike. Drives the running server (npm start) with
   Chromium. Usage: node scripts/browser-check.mjs [outDir] [postLatencyMs]
   A latency of 300 simulates a real network and reproduces input races. */

const out = process.argv[2] ?? 'output/browser-check'
mkdirSync(out, { recursive: true })
const latency = Number(process.argv[3] ?? 0)
const log = (...a) => console.log(...a)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 900, height: 900 } })
const errors = []
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', e => errors.push(String(e)))
let posts = 0
page.on('request', r => { if (r.method() === 'POST') posts++ })

await page.route('**/_hyper/s/**', async route => {
  if (route.request().method() === 'POST' && latency > 0) await new Promise(r => setTimeout(r, latency))
  await route.continue()
})
console.log('simulated POST latency:', latency, 'ms')
const streamOpened = page.waitForRequest(r => r.url().includes('/stream'))
await page.goto(process.env.URL ?? 'http://localhost:3000/greeter')
await streamOpened
await page.waitForTimeout(500)
await page.screenshot({ path: `${out}/1-initial.png` })

const count = () => page.locator('span.tabular-nums').textContent()
await page.getByRole('button', { name: 'Increment' }).click()
await page.getByRole('button', { name: 'Increment' }).click()
await page.getByRole('button', { name: 'Decrement' }).click()
await page.getByRole('button', { name: 'Increment' }).click()
await page.waitForFunction(() => document.querySelector('span.tabular-nums')?.textContent === '2', null, { timeout: 3000 })
log('count after +,+,-,+ :', await count(), '| title:', await page.title())

const time1 = await page.locator('[data-slot=badge]').textContent()
await page.waitForTimeout(1500)
const time2 = await page.locator('[data-slot=badge]').textContent()
log('server time ticks:', time1, '->', time2)

const name = page.getByLabel('Your name')
await name.click()
await name.pressSequentially('Grace', { delay: 60 })
// pause long enough for the debounced post and its echo, plus a clock tick
await page.waitForTimeout(450)
await name.pressSequentially(' Hop', { delay: 60 })
await page.waitForTimeout(260)
await name.pressSequentially('per', { delay: 60 })
await page.waitForTimeout(700 + latency)
log('input value after typing (slow, 60ms/key):', JSON.stringify(await name.inputValue()))
log('submit enabled:', await page.getByRole('button', { name: 'Save greeting' }).isEnabled())

await name.fill('')
await name.pressSequentially('Ada Lovelace', { delay: 15 })
await page.waitForTimeout(700 + latency)
log('input value after typing (fast, 15ms/key):', JSON.stringify(await name.inputValue()))

await page.getByRole('button', { name: 'Save greeting' }).click()
await page.waitForTimeout(100)
log('while saving:', (await page.locator('form button').textContent())?.trim())
await page.screenshot({ path: `${out}/2-saving.png` })
await page.getByText('Hello, Ada Lovelace!').waitFor({ timeout: 3000 })
await page.waitForTimeout(300)
log('greeting rendered; input after save:', JSON.stringify(await name.inputValue()))
// a second round must also clear, even though the attribute never changed
await name.pressSequentially('Linus', { delay: 40 })
await page.waitForTimeout(500 + latency)
await name.press('Enter')
await page.getByText('Hello, Linus!').waitFor({ timeout: 3000 })
await page.waitForTimeout(300)
log('after Enter-submit: input', JSON.stringify(await name.inputValue()), '| greetings:', await page.locator('li').allTextContents())
await page.screenshot({ path: `${out}/3-saved.png` })

log('POST requests:', posts)
log('console errors:', errors.length ? errors : 'none')
await browser.close()
