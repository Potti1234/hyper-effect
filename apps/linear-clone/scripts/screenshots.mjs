import { chromium } from 'playwright'

/* Screenshots of the main screens, against a running server:
   node scripts/screenshots.mjs   (writes screenshots/*.png) */

const base = process.env.URL ?? 'http://localhost:4100'
const out = new URL('../screenshots/', import.meta.url)
const browser = await chromium.launch()

const signIn = async (name, path) => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage()
  await page.goto(`${base}${path}`)
  await page.getByLabel('Your name').fill(name)
  const stream = page.waitForRequest(request => request.url().includes('/stream'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await stream
  await page.waitForFunction(() => document.querySelector('#hyper-keys[data-hyper-keys]') !== null)
  await page.waitForTimeout(400)
  return page
}
const visit = async (page, path) => {
  const stream = page.waitForRequest(request => request.url().includes('/stream'))
  await page.goto(`${base}${path}`)
  await stream
  await page.waitForFunction(() => document.querySelector('#hyper-keys[data-hyper-keys]') !== null)
  await page.waitForTimeout(400)
}
const shot = (page, name) => page.screenshot({ path: new URL(`${name}.png`, out).pathname.replace(/^\/([A-Za-z]:)/, '$1') })
const focused = page => page.waitForFunction(() => document.activeElement?.id === 'picker-input')
// Shortcuts are off while an overlay is open; the island learns it is closed with the next morph.
// Closed when the panel is gone and the key table has the list keys again.
const closed = page =>
  page.waitForFunction(
    () => document.querySelector('#picker') === null && (document.querySelector('#hyper-keys')?.getAttribute('data-hyper-keys') ?? '').includes('["c",'),
  )

try {
  const ada = await signIn('Ada', '/team/ENG')
  await ada.keyboard.press('j')
  await ada.keyboard.press('j')
  await ada.waitForTimeout(300)
  await shot(ada, 'list')

  await ada.keyboard.press('s')
  await focused(ada)
  await ada.waitForTimeout(200)
  await shot(ada, 'list-status-picker')
  await ada.keyboard.press('Escape')
  await closed(ada)

  await ada.locator('#filter-button').click()
  await focused(ada)
  await ada.keyboard.type('bug', { delay: 20 })
  await ada.waitForTimeout(400)
  await shot(ada, 'list-filter')
  await ada.keyboard.press('Enter')
  await ada.keyboard.press('Escape')
  await closed(ada)
  await ada.waitForTimeout(300)
  await shot(ada, 'list-filtered')
  await ada.getByRole('button', { name: 'Remove Label filter' }).click()

  await ada.keyboard.press('Control+k')
  await focused(ada)
  await ada.waitForTimeout(200)
  await shot(ada, 'command-palette')
  await ada.keyboard.type('go to', { delay: 20 })
  await ada.waitForTimeout(400)
  await shot(ada, 'command-palette-filtered')
  await ada.keyboard.press('Escape')
  await closed(ada)

  await ada.keyboard.press('c')
  await ada.waitForFunction(() => document.activeElement?.id === 'draft-title')
  await ada.keyboard.type('Checkout fails for EU cards', { delay: 15 })
  await ada.locator('#draft-description').fill('Cards issued in the EU are declined at the 3-D Secure step since Tuesday.')
  await ada.locator('#draft-priority').click()
  await focused(ada)
  await ada.keyboard.press('2')
  await ada.locator('#draft-assignee').click()
  await focused(ada)
  await ada.waitForTimeout(300)
  await shot(ada, 'create-issue')
  await ada.keyboard.type('grace', { delay: 20 })
  await ada.waitForTimeout(300)
  await ada.keyboard.press('Enter')
  await ada.locator('#draft-description').press('Control+Enter')
  await ada.waitForFunction(() => document.querySelector('#toast')?.textContent?.includes('Created'))
  await ada.waitForTimeout(300)
  await shot(ada, 'create-issue-done')
  const created = await ada.evaluate(() => document.querySelector('#toast')?.textContent?.match(/[A-Z]+-\d+/)?.[0])

  await visit(ada, '/team/ENG?view=board')
  await shot(ada, 'board')

  const grace = await signIn('Grace', `/issue/${created}`)
  await visit(ada, `/issue/${created}`)
  await grace.locator('#comment-input').fill('I can reproduce it with a Visa test card. Looking into the 3DS redirect.')
  await grace.locator('#comment-input').press('Control+Enter')
  await ada.waitForFunction(() => document.querySelector('#activity')?.textContent?.includes('Visa test card'))
  await grace.locator('#property-status').click()
  await focused(grace)
  await grace.keyboard.press('3')
  await ada.waitForFunction(() => document.querySelector('#property-status')?.textContent?.includes('In Progress'))
  await ada.waitForTimeout(600)
  await shot(ada, 'issue-detail')
  await ada.locator('#property-labels').click()
  await focused(ada)
  await ada.waitForTimeout(200)
  await shot(ada, 'issue-detail-labels')
  await ada.keyboard.press('Escape')
  await closed(ada)

  await ada.locator('#theme-toggle').click()
  await ada.waitForFunction(() => document.querySelector('#app')?.classList.contains('dark'))
  await ada.waitForTimeout(300)
  await shot(ada, 'issue-detail-dark')
  await visit(ada, '/team/ENG')
  await shot(ada, 'list-dark')
  await ada.locator('#theme-toggle').click()
  await ada.waitForFunction(() => !document.querySelector('#app')?.classList.contains('dark'))
} finally {
  await browser.close()
}
console.log('screenshots written')
