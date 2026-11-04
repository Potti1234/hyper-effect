import { chromium } from 'playwright'

/* Click-to-morph latency, for the person who clicks and for a second person
   watching the same list. Run against a production server:

     APP_SECRET=… HYPER_SNAPSHOT_SECRET=… NODE_ENV=production PORT=4100 node --import tsx src/main.ts
     node scripts/measure.mjs [rounds]

   Each round: Ada opens the status picker of one issue, then the clock starts
   at the click on a status (a capture listener in her page) and stops when
   the row's `data-status` changes, in her page and in Grace's. Both pages run
   in one browser on this machine, so their clocks agree. */

const base = process.env.URL ?? 'http://localhost:4100'
const rounds = Number(process.argv[2] ?? 30)
const browser = await chromium.launch()

const signIn = async name => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  page.on('framenavigated', frame => process.env.DEBUG && console.error(name, 'navigated', frame.url()))
  page.on('console', message => process.env.DEBUG && console.error(name, message.type(), message.text()))
  await page.goto(`${base}/team/ENG`)
  await page.getByLabel('Your name').fill(name)
  const stream = page.waitForRequest(request => request.url().includes('/stream'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await stream
  await page.waitForFunction(() => document.querySelector('#hyper-keys[data-hyper-keys]') !== null)
  await page.waitForTimeout(300)
  return page
}

/** Records in the page when the row shows the status (no promise is kept
 *  across evaluations: the time is stored on window and polled). */
const watch = (page, id, status) =>
  page.evaluate(
    ([id, status]) => {
      window.__seenAt = 0
      const observer = new MutationObserver(() => {
        if (document.querySelector(`#row-${id}`)?.dataset.status === status) {
          observer.disconnect()
          window.__seenAt = Date.now()
        }
      })
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-status'] })
    },
    [id, status],
  )

const seenAt = async page => {
  await page.waitForFunction(() => window.__seenAt > 0, undefined, { timeout: 10000, polling: 5 })
  return page.evaluate(() => window.__seenAt)
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

try {
  const ada = await signIn('Ada')
  const grace = await signIn('Grace')
  const id = 'ENG-6'
  const actor = []
  const watcher = []
  const pickerOpen = []
  const pickerFocus = []
  const keySelect = []
  for (let round = 0; round < rounds; round += 1) {
    // Toggle between two statuses, whatever the issue has now.
    const current = await ada.evaluate(id => document.querySelector(`#row-${id}`)?.dataset.status, id)
    const status = current === 'in_progress' ? 'todo' : 'in_progress'
    const label = status === 'in_progress' ? 'In Progress' : 'Todo'
    // Opening the picker: click → panel in the page → its input focused (a forwarded focus).
    await ada.evaluate(() => {
      window.__openClick = 0
      window.__pickerAt = 0
      window.__focusAt = 0
      document.addEventListener('click', () => (window.__openClick = Date.now()), { capture: true, once: true })
      const observer = new MutationObserver(() => {
        if (window.__pickerAt === 0 && document.querySelector('#picker') !== null) window.__pickerAt = Date.now()
      })
      observer.observe(document.documentElement, { subtree: true, childList: true })
      const onFocus = event => {
        if (event.target.id === 'picker-input') {
          window.__focusAt = Date.now()
          // Focus can come in the morph's own task, before the observer's
          // callback runs: the panel is in the page by then.
          if (window.__pickerAt === 0 && document.querySelector('#picker') !== null) window.__pickerAt = window.__focusAt
          observer.disconnect()
          document.removeEventListener('focusin', onFocus)
        }
      }
      document.addEventListener('focusin', onFocus)
    })
    await ada.locator(`#row-${id} [aria-label^="Status"]`).click()
    await ada.waitForFunction(() => window.__focusAt > 0 && window.__pickerAt > 0, undefined, { polling: 5 })
    const [openClick, pickerAt, focusAt] = await ada.evaluate(() => [window.__openClick, window.__pickerAt, window.__focusAt])
    pickerOpen.push(pickerAt - openClick)
    pickerFocus.push(focusAt - openClick)
    await watch(ada, id, status)
    await watch(grace, id, status)
    await ada.evaluate(() => {
      document.addEventListener('click', () => (window.__clickedAt = Date.now()), { capture: true, once: true })
    })
    await ada.getByRole('option', { name: new RegExp(`^${label}`) }).click()
    const seenByActor = await seenAt(ada)
    const clickedAt = await ada.evaluate(() => window.__clickedAt)
    const seenByWatcher = await seenAt(grace)
    actor.push(seenByActor - clickedAt)
    watcher.push(seenByWatcher - clickedAt)
    await ada.waitForTimeout(100)
  }
  // The keyboard: j → the next row is marked selected (key binding → server → morph).
  for (let round = 0; round < rounds; round += 1) {
    await ada.evaluate(() => {
      window.__keyAt = 0
      window.__selectedAt = 0
      const before = document.querySelector('[data-selected="true"]')?.id
      document.addEventListener('keydown', () => (window.__keyAt = Date.now()), { capture: true, once: true })
      const observer = new MutationObserver(() => {
        const now = document.querySelector('[data-selected="true"]')?.id
        if (now !== undefined && now !== before) {
          window.__selectedAt = Date.now()
          observer.disconnect()
        }
      })
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-selected'] })
    })
    await ada.keyboard.press(round % 2 === 0 ? 'j' : 'k')
    await ada.waitForFunction(() => window.__selectedAt > 0, undefined, { polling: 5 })
    keySelect.push(await ada.evaluate(() => window.__selectedAt - window.__keyAt))
  }
  const summary = (name, values) =>
    console.log(`${name.padEnd(44)} median ${percentile(values, 50)} ms · p95 ${percentile(values, 95)} ms · max ${Math.max(...values)} ms`)
  console.log(`${rounds} rounds against ${base}`)
  summary('click → morph, the person who clicked', actor)
  summary('click → morph, a second person watching', watcher)
  summary('click → picker rendered', pickerOpen)
  summary('click → picker input focused', pickerFocus)
  summary('j/k key → selection moved', keySelect)
} finally {
  await browser.close()
}
