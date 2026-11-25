import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

/* Browser check of extensions against a running server (npm start, with
   extensions reloaded on change, the default): the Stand-up extension's
   sidebar entry and page, a new version of it swapped in while the page is
   open, and the extension unloaded and loaded again while another person's
   page shows the sidebar.

   Then the slots of the issue lists (badges from extensions/stale, palette
   entries from extensions/related and extensions/standup), the sections of
   /extensions ("Customize", roles under "People": Ada administers, Grace
   only looks until Ada gives her the role), and an extension turned off and
   on.

   The last part changes the app by prompt in /extensions/chat: the chat
   shows what the agent did and the checks, a run waits for review, Ada
   reads the diff and approves it, a follow-up stays in its conversation; a
   change that fails the typecheck or the extension's own tests fails. It
   needs the server started with JELLYWARE_AGENT=script (a scripted agent
   instead of pi); without it, that part is skipped.

   It edits extensions/standup/ and puts the files back when it ends.

   Usage: node scripts/check-extensions.mjs   (URL=… for another server) */

const base = process.env.URL ?? 'http://localhost:4200'
const TIMEOUT = Number(process.env.CHECK_TIMEOUT ?? 10000)
const folder = fileURLToPath(new URL('../extensions/standup', import.meta.url))
const pageFile = join(folder, 'page.ts')
const original = readFileSync(pageFile, 'utf8')
const entryFile = join(folder, 'extension.ts')
const originalEntry = readFileSync(entryFile, 'utf8')
const RUN_TIMEOUT = 5 * 60 * 1000
const parked = join(tmpdir(), `jellyware-standup-${Date.now()}`)
const calendarFile = fileURLToPath(new URL('../extensions/activity/calendar.ts', import.meta.url))
const originalCalendar = readFileSync(calendarFile, 'utf8')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}
const until = (page, predicate, arg) =>
  page.waitForFunction(predicate, arg, { timeout: TIMEOUT }).then(() => true, () => false)

const browser = await chromium.launch()
const people = []
const signIn = async name => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(`${name}: ${error}`))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`${name}: ${message.text()} ${message.location().url ?? ''}`)
  })
  await page.goto(`${base}/team/ENG`)
  await page.getByLabel('Your name').fill(name)
  const stream = page.waitForRequest(request => request.url().includes('/stream'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await stream
  const person = { page, errors }
  people.push(person)
  return person
}
const hasEntry = page => page.evaluate(() => document.querySelector('#sidebar a[href="/standup"]') !== null)

try {
  const ada = await signIn('Ada')
  const grace = await signIn('Grace')

  check('the sidebar shows the extension’s entry', await hasEntry(ada.page))

  // THE PAGE
  const stream = ada.page.waitForRequest(request => request.url().includes('/_hyper/standup/'))
  await ada.page.click('#sidebar a[href="/standup"]')
  await stream
  await ada.page.waitForSelector('#standup-board')
  const cards = await ada.page.locator('#standup-board section').count()
  check('the extension page shows one card per member', cards >= 6, `${cards} cards`)
  check(
    'its entry is marked as the page shown',
    (await ada.page.getAttribute('#sidebar a[href="/standup"]', 'aria-current')) === 'page',
  )

  await ada.page.click('#standup-show-review')
  check('a click on the extension page reaches its update', await until(ada.page, () => !document.querySelector('#standup-show-review').checked))

  // A NEW VERSION WHILE THE PAGE IS OPEN
  await ada.page.evaluate(() => {
    window.__sameDocument = true
  })
  writeFileSync(pageFile, original.replace("['Stand-up']", "['Stand-up, version 2']"))
  check(
    'a new version of the extension reaches the open page',
    await until(ada.page, () => document.querySelector('#standup-header h1')?.textContent === 'Stand-up, version 2'),
  )
  check('without reloading the page', await ada.page.evaluate(() => window.__sameDocument === true))
  check(
    'and the session’s state carried over (snapshot restored)',
    await ada.page.evaluate(() => !document.querySelector('#standup-show-review').checked),
  )
  await ada.page.click('#standup-show-review')
  check('the new version takes events', await until(ada.page, () => document.querySelector('#standup-show-review').checked))

  // A CLASS NO OTHER CODE USES: the CSS is built again and the open page loads it
  const colorBefore = await ada.page.evaluate(() => getComputedStyle(document.querySelector('#standup-header h1')).color)
  writeFileSync(
    pageFile,
    original
      .replace("['Stand-up']", "['Stand-up, version 3']")
      .replace("h.h1([h.Class('flex-1 text-[13px] font-semibold')]", "h.h1([h.Class('flex-1 text-[13px] font-semibold text-lime-600')]"),
  )
  check(
    'a new Tailwind class reaches the open page',
    await until(
      ada.page,
      before => {
        const h1 = document.querySelector('#standup-header h1')
        return h1?.textContent === 'Stand-up, version 3' && getComputedStyle(h1).color !== before
      },
      colorBefore,
    ),
  )
  check('still without reloading the page', await ada.page.evaluate(() => window.__sameDocument === true))

  // UNLOADING AND LOADING AGAIN
  await ada.page.goto(`${base}/team/ENG`)
  renameSync(folder, parked)
  check('removing the extension removes its entry from an open page', await until(grace.page, () => document.querySelector('#sidebar a[href="/standup"]') === null))
  const gone = await fetch(`${base}/standup`, { redirect: 'manual' })
  check('and its page', gone.status === 404 || gone.status === 303, `status ${gone.status}`)
  renameSync(parked, folder)
  check('putting it back adds the entry again', await until(grace.page, () => document.querySelector('#sidebar a[href="/standup"]') !== null))

  // A swapped page breaks its open stream on purpose, so Datastar reconnects:
  // Chrome logs that one as a failed resource.
  // CARDS IN THE APP'S OWN PAGES (extensions/related, slot issue.sidebar)
  const openIssue = async (page, identifier) => {
    const stream = page.waitForRequest(request => request.url().includes('/_hyper/issue/'))
    await page.goto(`${base}/issue/${identifier}`)
    await stream
    await page.waitForSelector('#extension-cards')
  }
  let target = null
  for (let n = 1; n <= 30 && target === null; n++) {
    await openIssue(ada.page, `ENG-${n}`)
    if ((await ada.page.locator('#card-related-action-0').count()) > 0) target = `ENG-${n}`
  }
  check('an extension’s card shows on an issue page, with its action', target !== null, target ?? 'no issue offers Mark urgent')
  if (target !== null) {
    check('with links to related issues', (await ada.page.locator('#card-related a[href^="/issue/"]').count()) > 0)
    await openIssue(grace.page, target)
    await ada.page.click('#card-related-action-0')
    check('its action runs the extension’s command', await until(ada.page, () => document.querySelector('#notice')?.textContent?.includes('urgent') === true))
    check('which changes the issue for another person', await until(grace.page, () => document.querySelector('#property-priority')?.textContent?.includes('Urgent') === true))
    check('and the card follows the data (no more Mark urgent)', await until(ada.page, () => document.querySelector('#card-related-action-0') === null))
  }

  // SETTINGS (extensions/related: title, max, urgentAction)
  if (target !== null) {
    await openIssue(grace.page, target)
    const cardTitle = () => grace.page.evaluate(() => document.querySelector('#card-related h3')?.textContent ?? null)
    const cardItems = () => grace.page.evaluate(() => document.querySelectorAll('#card-related li').length)
    const itemsBefore = await cardItems()
    await ada.page.goto(`${base}/extensions`)
    await ada.page.waitForSelector('#settings-related')
    await ada.page.waitForTimeout(300)
    const save = async values => {
      await ada.page.click('#settings-related')
      await ada.page.waitForSelector('#settings-form-related')
      for (const [key, value] of Object.entries(values)) await ada.page.fill(`#setting-related-${key}`, value)
      await ada.page.click('#settings-save-related')
      await ada.page.waitForFunction(() => /Saved|put back/.test(document.querySelector('#workshop-notice')?.textContent ?? ''), null, { timeout: TIMEOUT })
      return ada.page.textContent('#workshop-notice')
    }
    const saved = await save({ title: 'Linked issues', max: '1' })
    check('a settings change is saved', saved.includes('Saved'), saved)
    check('and reaches another person’s open issue page', await until(grace.page, () => document.querySelector('#card-related h3')?.textContent === 'Linked issues'))
    check('with the new number of issues', (await cardItems()) <= 1, `${itemsBefore} → ${await cardItems()}`)

    const refused = await save({ max: '12' })
    check('a value the extension fails with is put back', refused.includes('put back') && refused.includes('at most 10'), refused)
    check('the extension keeps running with the earlier settings', (await cardTitle()) === 'Linked issues' && (await cardItems()) <= 1)
    check(
      'the history shows it as put back',
      await ada.page.evaluate(() => document.querySelector('#workshop-settings-history li')?.dataset.state === 'reverted'),
    )

    const undoButton = ada.page.locator('#workshop-settings-history button[id^="undo-settings-"]').first()
    await undoButton.click()
    check('undo puts the earlier settings back', await until(ada.page, () => (document.querySelector('#workshop-notice')?.textContent ?? '').includes('Undone')))
    check('on the other person’s page too', await until(grace.page, () => document.querySelector('#card-related h3')?.textContent === 'Related'))
  }

  // SECRET SETTINGS (extensions/triage: inboxToken)
  if (target !== null) {
    const TOKEN = `sk-check-${Date.now()}`
    await ada.page.goto(`${base}/extensions`)
    await ada.page.waitForSelector('#settings-triage')
    await ada.page.waitForTimeout(300)
    await ada.page.click('#settings-triage')
    await ada.page.waitForSelector('#setting-triage-inboxToken')
    check('a secret setting is a password field, empty', (await ada.page.getAttribute('#setting-triage-inboxToken', 'type')) === 'password' && (await ada.page.inputValue('#setting-triage-inboxToken')) === '')
    await ada.page.fill('#setting-triage-inboxToken', TOKEN)
    await ada.page.click('#settings-save-triage')
    check('it is saved', await until(ada.page, () => (document.querySelector('#workshop-notice')?.textContent ?? '').includes('Saved')))
    check('and shows only as set', await until(ada.page, () => (document.querySelector('#extension-triage')?.textContent ?? '').includes('inboxToken set')))
    const html = await ada.page.content()
    check('the page never holds the secret', !html.includes(TOKEN))
    const sessions = fileURLToPath(new URL('../.hyper-sessions', import.meta.url))
    const leaked = readdirSync(sessions, { recursive: true }).some(file => {
      try {
        return readFileSync(join(sessions, String(file)), 'utf8').includes(TOKEN)
      } catch {
        return false
      }
    })
    check('nor the settings store, in the clear', !leaked)
    await grace.page.goto(`${base}/triage`)
    check('the extension has it (its page says the token is set)', await until(grace.page, () => document.querySelector('#triage-inbox')?.dataset.connected === 'true'))
    check('and the page holds no token', !(await grace.page.content()).includes(TOKEN))
    await ada.page.click('#settings-triage')
    await ada.page.waitForSelector('#clear-triage-inboxToken')
    await ada.page.click('#clear-triage-inboxToken')
    check('removing it reaches the extension', await until(grace.page, () => document.querySelector('#triage-inbox')?.dataset.connected === 'false'))
  }

  // YOUR OWN SETTINGS (extensions/related: max is a member setting)
  if (target !== null) {
    await openIssue(ada.page, target)
    await openIssue(grace.page, target)
    const items = person => person.page.evaluate(() => document.querySelectorAll('#card-related li').length)
    const adaBefore = await items(ada)
    await grace.page.goto(`${base}/extensions`)
    await grace.page.waitForSelector('#mine-edit-related')
    await grace.page.waitForTimeout(300)
    await grace.page.click('#mine-edit-related')
    await grace.page.waitForSelector('#my-setting-related-max')
    await grace.page.fill('#my-setting-related-max', '1')
    await grace.page.click('#my-settings-save-related')
    check('a member changes a setting for themselves', await until(grace.page, () => (document.querySelector('#mine-values-related')?.textContent ?? '').includes('1 (yours)')))
    await openIssue(grace.page, target)
    check('their card follows it', (await items(grace)) <= 1, String(await items(grace)))
    check('another member’s card does not', (await items(ada)) === adaBefore && adaBefore > 1, `${adaBefore}`)
    await grace.page.goto(`${base}/extensions`)
    await grace.page.waitForSelector('#mine-reset-related')
    await grace.page.click('#mine-reset-related')
    check('and goes back to the default', await until(grace.page, () => (document.querySelector('#mine-values-related')?.textContent ?? '').includes('(default)')))
  }

  // DATA OF AN EXTENSION (extensions/pins: its own table)
  if (target !== null) {
    await openIssue(ada.page, target)
    await ada.page.waitForSelector('#card-pins-action-0')
    if ((await ada.page.textContent('#card-pins-action-0')).includes('Unpin')) {
      await ada.page.click('#card-pins-action-0')
      await until(ada.page, () => document.querySelector('#card-pins-action-0')?.textContent?.includes('Pin for me') === true)
    }
    await ada.page.click('#card-pins-action-0')
    check('an extension writes a row of its own table', await until(ada.page, () => document.querySelector('#card-pins-action-0')?.textContent?.includes('Unpin') === true))
    await ada.page.goto(`${base}/pinned`)
    check('its page reads it back', await until(ada.page, id => document.querySelector(`#pinned-${id}`) !== null, target))
    await grace.page.goto(`${base}/pinned`)
    await grace.page.waitForSelector('#pinned-list')
    check('rows are per member', (await grace.page.locator(`#pinned-${target}`).count()) === 0)
    await ada.page.click(`#unpin-${target}`)
    check('and removes it', await until(ada.page, id => document.querySelector(`#pinned-${id}`) === null, target))
    await ada.page.goto(`${base}/extensions`)
    await ada.page.waitForSelector('#extension-data-pins')
    check('the workshop shows its tables', (await ada.page.textContent('#extension-data-pins')).includes('pins (1 migration)'))
  }

  // CHARTS AND MAPS: islands the app ships, used by extensions
  {
    await ada.page.goto(`${base}/progress`)
    await ada.page.waitForSelector('app-chart [role="group"] svg', { timeout: TIMEOUT })
    await ada.page.waitForTimeout(400)
    check('an extension page shows a chart, drawn in the browser', (await ada.page.locator('app-chart path[data-line]').count()) > 0)
    const plot = await ada.page.locator('app-chart [role="group"]').boundingBox()
    await ada.page.mouse.move(plot.x + plot.width * 0.8, plot.y + plot.height * 0.5)
    check(
      'hovering shows a tooltip with every series at that day',
      await until(ada.page, () => {
        const text = document.querySelector('[data-chart-tooltip]')?.textContent ?? ''
        return text.includes('Engineering') && text.includes('Design') && text.includes('Total')
      }),
    )
    await ada.page.getByRole('button', { name: 'Daily' }).click()
    await ada.page.waitForSelector('app-chart path[data-bar]', { state: 'attached', timeout: TIMEOUT })
    await ada.page.waitForTimeout(300)
    const bar = await ada.page.evaluate(() => {
      const tall = [...document.querySelectorAll('app-chart path[data-bar]')].reverse().find(path => path.getBoundingClientRect().height > 6)
      const box = tall?.getBoundingClientRect()
      return box === undefined ? null : { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    })
    if (bar !== null) await ada.page.mouse.click(bar.x, bar.y)
    check(
      'a click on a bar reaches the page’s update (its day’s tickets)',
      bar !== null && (await until(ada.page, () => (document.querySelector('#progress-list h2')?.textContent ?? '').startsWith('Completed on'))),
    )
    await ada.page.locator('app-chart [role="group"]').focus()
    await ada.page.keyboard.press('Home')
    check('the keyboard moves the tooltip', await until(ada.page, () => document.querySelector('[data-chart-tooltip]') !== null))
    await ada.page.click('app-chart button[data-series="DES"]')
    check('the legend hides a series', await until(ada.page, () => document.querySelectorAll('app-chart path[data-bar^="DES"]').length === 0))
    await ada.page.click('app-chart button[data-chart-table]')
    check('and a table view lists every day', await until(ada.page, () => document.querySelectorAll('app-chart table tbody tr').length === 30))
    await ada.page.evaluate(() => {
      window.__chart = document.querySelector('app-chart')
    })
    await ada.page.getByRole('button', { name: '90 days' }).click()
    check(
      'new data from the server reaches the open chart, which keeps what the reader chose',
      (await until(ada.page, () => document.querySelectorAll('app-chart table tbody tr').length === 90)) &&
        (await ada.page.evaluate(() => document.querySelector('app-chart') === window.__chart)),
    )

    await ada.page.goto(`${base}/team-map`)
    check('an extension page shows a map with a marker per city', await until(ada.page, () => document.querySelectorAll('app-map [data-place]').length === 6))
    check('with tiles loaded', await until(ada.page, () => document.querySelector('app-map canvas') !== null))
    const helsinki = ada.page.locator('app-map [data-map-marker-id="Helsinki"]')
    await ada.page.waitForTimeout(1500)
    const spot = await helsinki.boundingBox()
    await ada.page.mouse.move(spot.x + spot.width / 2, spot.y + spot.height / 2)
    check(
      'hovering a marker shows its tooltip',
      await until(ada.page, () => {
        const tip = document.querySelector('[data-map-marker-id="Helsinki"] [role="tooltip"]')
        return tip !== null && getComputedStyle(tip).display !== 'none' && tip.textContent.includes('Linus Torvalds')
      }),
    )
    await ada.page.mouse.click(spot.x + spot.width / 2, spot.y + spot.height / 2)
    check('a click on a marker reaches the page’s update', await until(ada.page, () => (document.querySelector('#team-map-city h2')?.textContent ?? '').startsWith('Helsinki')))
    check('and the island rings it', await until(ada.page, () => document.querySelector('[data-place="Helsinki"]')?.className.includes('ring-4') === true))
  }

  // AN EXTENSION'S OWN BROWSER CODE (extensions/activity: an island in a sandboxed frame)
  {
    await ada.page.goto(`${base}/activity`)
    await ada.page.waitForSelector('jellyware-island iframe', { timeout: TIMEOUT })
    const calendar = ada.page.frameLocator('jellyware-island iframe')
    await calendar.locator('button[data-date]').first().waitFor({ timeout: TIMEOUT })
    check('an extension’s island runs in its frame', (await calendar.locator('button[data-date]').count()) === 140)
    check('a sandboxed one, scripts only', (await ada.page.getAttribute('jellyware-island iframe', 'sandbox')) === 'allow-scripts')
    const inside = ada.page.frames().find(frame => frame.url().includes('/_jellyware/islands/activity/calendar/'))
    const probe = await inside.evaluate(async () => {
      const blocked = async run => {
        try {
          await run()
          return false
        } catch {
          return true
        }
      }
      return {
        cookie: await blocked(() => document.cookie),
        page: await blocked(() => window.parent.document.title),
        network: await blocked(() => fetch('/team/ENG')),
        storage: await blocked(() => localStorage.setItem('x', '1')),
      }
    })
    check(
      'without cookies, storage, network or the page',
      probe.cookie && probe.page && probe.network && probe.storage,
      JSON.stringify(probe),
    )
    await calendar.locator('button[data-date]').nth(130).hover()
    check('its tooltip shows on hover', await calendar.locator('[data-calendar-tooltip]').textContent().then(text => /change/.test(text ?? ''), () => false))
    const busiest = await calendar.locator('button[data-date]').evaluateAll(cells =>
      cells.map(cell => [cell.dataset.date, Number(/: (\d+) changes/.exec(cell.getAttribute('aria-label') ?? '')?.[1] ?? 0)]).sort((a, b) => b[1] - a[1])[0][0],
    )
    await calendar.locator(`button[data-date="${busiest}"]`).click()
    check(
      'a click in the island reaches the page’s update',
      await until(ada.page, date => (document.querySelector('#activity-day h2')?.textContent ?? '').includes(date), busiest),
    )
    // A new version of the island reaches the open page.
    await ada.page.evaluate(() => {
      window.__sameDocument = true
    })
    const before = await ada.page.getAttribute('jellyware-island iframe', 'src')
    writeFileSync(calendarFile, originalCalendar.replace("['Less', ...STEPS", "['Fewer', ...STEPS"))
    check(
      'a new version of the island reloads its frame on the open page',
      await ada.page
        .waitForFunction(old => document.querySelector('jellyware-island iframe')?.getAttribute('src') !== old, before, { timeout: 60000 })
        .then(
          () => calendar.locator('text=Fewer').waitFor({ timeout: TIMEOUT }).then(() => true, () => false),
          () => false,
        ),
    )
    check('without reloading the page', await ada.page.evaluate(() => window.__sameDocument === true))
    writeFileSync(calendarFile, originalCalendar)
    await ada.page.goto(`${base}/extensions`)
    await ada.page.waitForSelector('#extension-islands-activity')
    check('the workshop lists the extension’s browser code', (await ada.page.textContent('#extension-islands-activity')).includes('calendar'))
  }

  // SLOTS IN THE ISSUE LISTS
  const openList = async path => {
    const stream = ada.page.waitForRequest(request => request.url().includes('/stream'))
    await ada.page.goto(`${base}${path}`)
    await stream
    await ada.page.waitForSelector('#issue-list')
    await ada.page.waitForTimeout(400)
  }
  await openList('/team/ENG')
  check('an extension’s badges show on issue rows', (await ada.page.locator('#issue-list [data-badge="stale"]').count()) > 0)
  await openList('/team/ENG?view=board')
  check('and on board cards', (await ada.page.locator('#column-todo [data-badge="stale"], #column-backlog [data-badge="stale"], #column-in_progress [data-badge="stale"]').count()) > 0)
  await openList('/team/ENG')
  // Select the first issue that is not urgent (j moves the selection).
  const steps = await ada.page.evaluate(() =>
    [...document.querySelectorAll('#issue-list [id^="row-"]')].findIndex(row => row.querySelector('[aria-label="Priority: Urgent"]') === null),
  )
  for (let i = 0; i <= steps; i++) await ada.page.keyboard.press('j')
  const chosen = await ada.page.evaluate(() => new Promise(resolve => setTimeout(() => resolve(document.querySelector('[data-selected="true"]')?.id.slice(4)), 400)))
  await ada.page.keyboard.press('Control+k')
  await until(ada.page, () => document.activeElement?.id === 'picker-input')
  check(
    'the palette lists an extension’s action for the selected issue',
    await until(ada.page, id => [...document.querySelectorAll('#picker [role="option"]')].some(option => option.textContent?.includes(`Mark ${id} urgent`)), chosen),
    chosen,
  )
  check('and an extension’s link', await until(ada.page, () => (document.querySelector('#picker')?.textContent ?? '').includes('Open Stand-up')))
  await ada.page.getByRole('option', { name: `Mark ${chosen} urgent` }).click()
  check('the action runs the extension’s command', await until(ada.page, id => document.querySelector(`#row-${id} [aria-label="Priority: Urgent"]`) !== null, chosen))
  await ada.page.keyboard.press('Control+k')
  await until(ada.page, () => document.activeElement?.id === 'picker-input')
  await until(ada.page, () => (document.querySelector('#picker')?.textContent ?? '').includes('Open Stand-up'))
  await ada.page.getByRole('option', { name: 'Open Stand-up' }).click()
  check('the link opens its page', await until(ada.page, () => location.pathname === '/standup'))

  // THE SECTIONS OF /extensions, AND WHAT YOU CAN CUSTOMIZE
  await ada.page.goto(`${base}/extensions`)
  await ada.page.waitForSelector('#workshop-extensions')
  await ada.page.evaluate(() => {
    window.__sameDocument = true
  })
  check('and what each extension adds', (await ada.page.textContent('#extension-adds-stale')).includes('badges on issues'))
  await ada.page.click('#section-customize')
  check('a section opens from the second sidebar', await until(ada.page, () => document.querySelector('#workshop-customize') !== null && location.pathname === '/extensions/customize'))
  check('within the session', await ada.page.evaluate(() => window.__sameDocument === true))
  await ada.page.waitForTimeout(300)
  check('the workshop lists every place an extension can change', (await ada.page.locator('#workshop-customize > ul > li').count()) === 8)
  check(
    'with what fills each now',
    (await ada.page.textContent('#customize-issues-badges')).includes('Stale issues') &&
      (await ada.page.textContent('#customize-issues-palette')).includes('Related issues'),
  )
  await ada.page.click('#try-issues-badges')
  check(
    'an example opens a new conversation with it',
    await until(ada.page, () => location.pathname === '/extensions/chat' && document.querySelector('#workshop-prompt')?.value.includes('Overdue') === true),
  )
  await ada.page.fill('#workshop-prompt', '')
  await ada.page.goBack()
  check('back goes to the section before', await until(ada.page, () => document.querySelector('#workshop-customize') !== null))

  // ROLES
  await grace.page.goto(`${base}/extensions/chat`)
  await grace.page.waitForSelector('#workshop-form')
  check(
    'a member sees who may change the app, and no prompt',
    (await grace.page.textContent('#workshop-form')).includes('Only administrators') && (await grace.page.locator('#workshop-prompt').count()) === 0,
  )
  await grace.page.goto(`${base}/extensions`)
  await grace.page.waitForSelector('#workshop-extensions')
  check(
    'nor settings buttons, nor switches',
    (await grace.page.locator('#workshop-extensions button[id^="settings-"], #workshop-extensions [id^="toggle-"]').count()) === 0,
  )
  await grace.page.goto(`${base}/extensions/customize`)
  await grace.page.waitForSelector('#workshop-customize')
  check('nor examples to try', (await grace.page.locator('#workshop-customize button').count()) === 0)
  await grace.page.goto(`${base}/extensions/chat`)
  await grace.page.waitForSelector('#workshop-form')
  await ada.page.goto(`${base}/extensions/people`)
  await ada.page.waitForSelector('#role-grace')
  await ada.page.click('#role-grace')
  check('an administrator gives the role, and the member’s open page follows', await until(grace.page, () => document.querySelector('#workshop-prompt') !== null))
  await grace.page.click('#section-extensions')
  check('with the settings buttons', await until(grace.page, () => document.querySelector('#settings-related') !== null))
  await ada.page.click('#role-grace')
  check('and takes it back', await until(grace.page, () => document.querySelector('#settings-related') === null))

  // TURNING AN EXTENSION OFF AND ON
  await grace.page.goto(`${base}/team/ENG`)
  await grace.page.waitForSelector('#sidebar a[href="/standup"]')
  await ada.page.goto(`${base}/extensions`)
  await ada.page.waitForSelector('#toggle-standup')
  await ada.page.click('#toggle-standup')
  check('turning an extension off unloads it', await until(ada.page, () => document.querySelector('#extension-standup')?.dataset.state === 'disabled'))
  check('its entry leaves another person’s open page', await until(grace.page, () => document.querySelector('#sidebar a[href="/standup"]') === null))
  const off = await fetch(`${base}/standup`, { redirect: 'manual' })
  check('and its page is gone', off.status === 404 || off.status === 303, `status ${off.status}`)
  await ada.page.click('#toggle-standup')
  check('turning it on loads it again', await until(ada.page, () => document.querySelector('#extension-standup')?.dataset.state === 'active'))
  check('and its entry comes back', await until(grace.page, () => document.querySelector('#sidebar a[href="/standup"]') !== null))

  // CHANGES BY PROMPT
  if (process.env.JELLYWARE_AGENT === 'script') {
    await ada.page.goto(`${base}/extensions`)
    await ada.page.waitForSelector('#workshop-extensions')
    check('the workshop lists the loaded extension', await until(ada.page, () => document.querySelector('#extension-standup')?.dataset.state === 'active'))
    /** Sends a message in Chat: a new conversation, or (`followUp`) one
     *  in the conversation open now. */
    const prompt = async (text, followUp = false) => {
      if (!followUp) {
        await ada.page.goto(`${base}/extensions/chat`)
        await ada.page.waitForSelector('#workshop-prompt')
        await ada.page.waitForTimeout(300)
      }
      const before = await ada.page.locator('#workshop-chat article').count()
      await ada.page.fill('#workshop-prompt', text)
      await ada.page.click('#workshop-submit')
      await ada.page.waitForFunction(count => document.querySelectorAll('#workshop-chat article').length > count, before, { timeout: TIMEOUT })
      const id = await ada.page.evaluate(() => [...document.querySelectorAll('#workshop-chat article')].at(-1).id)
      await ada.page.waitForFunction(
        selector => ['review', 'installed', 'failed', 'unchanged'].includes(document.querySelector(selector)?.dataset.state),
        `#${id}`,
        { timeout: RUN_TIMEOUT },
      )
      return { id, state: await ada.page.getAttribute(`#${id}`, 'data-state'), text: await ada.page.textContent(`#${id}`) }
    }
    const daily = await prompt("replace standup/extension.ts :: label: 'Stand-up' => label: 'Daily'")
    check('a checked prompt waits for review', daily.state === 'review', daily.state)
    const runId = daily.id.slice(4)
    check('the conversation has its own address', await ada.page.evaluate(id => location.pathname === `/extensions/chat/${id}`, runId))
    check(
      'the chat shows the tool the agent called',
      (await ada.page.locator(`#${daily.id} [data-tool="edit"][data-state="done"]`).count()) === 1 && daily.text.includes('standup/extension.ts'),
    )
    check(
      'and each check, passed',
      ['Manifests and credentials', 'Imports', 'Typecheck', 'Tests'].every(name => daily.text.includes(name)) &&
        (await ada.page.locator(`#${daily.id} [data-step^="check-"][data-state="failed"]`).count()) === 0,
    )
    check('and what the agent said, without its Changed: line', daily.text.includes('Replaced the text') && !daily.text.includes('Changed: standup'))
    check(
      'with the diff of what it changes',
      await until(
        ada.page,
        selector => {
          const diff = document.querySelector(selector)
          return diff?.querySelector('[data-file="standup/extension.ts"]') !== null && /\+ .*Daily/.test(diff?.textContent ?? '')
        },
        `#diff-${runId}`,
      ),
    )
    check('nothing is live before approval', [...(await grace.page.$$eval('#sidebar a', links => links.map(link => link.textContent)))].includes('Stand-up'))
    await ada.page.click(`#approve-${runId}`)
    check('approval installs it', await until(ada.page, selector => document.querySelector(selector)?.dataset.state === 'installed', `#${daily.id}`))
    check('and names who approved', (await ada.page.textContent(`#${daily.id}`)).includes('approved by Ada'))
    check('and changes another person’s open page', await until(grace.page, () => [...document.querySelectorAll('#sidebar a')].some(link => link.textContent === 'Daily')))
    await ada.page.click(`#undo-${runId}`)
    check('undo takes it back', await until(ada.page, selector => document.querySelector(selector)?.dataset.state === 'undone', `#${daily.id}`))
    check('on the other person’s page too', await until(grace.page, () => [...document.querySelectorAll('#sidebar a')].some(link => link.textContent === 'Stand-up')))
    const rejected = await prompt("replace standup/extension.ts :: label: 'Stand-up' => label: 'Never'", true)
    check(
      'a follow-up stays in its conversation',
      (await ada.page.locator('#workshop-chat article').count()) === 2 && (await ada.page.evaluate(id => location.pathname === `/extensions/chat/${id}`, runId)),
    )
    await ada.page.click(`#reject-${rejected.id.slice(4)}`)
    check('a rejected run changes nothing', await until(ada.page, selector => document.querySelector(selector)?.dataset.state === 'rejected', `#${rejected.id}`))
    check('and stays out of the sidebar', ![...(await grace.page.$$eval('#sidebar a', links => links.map(link => link.textContent)))].includes('Never'))
    const liveBefore = readFileSync(pageFile, 'utf8')
    const broken = await prompt("replace standup/page.ts :: export const PATH = '/standup' => export const PATH: number = '/standup'")
    check('a change that does not typecheck fails', broken.state === 'failed' && broken.text.includes('TS2322'), broken.state)
    check('and leaves the live extension alone', readFileSync(pageFile, 'utf8') === liveBefore)
    const migrated = await prompt('replace pins/extension.json :: pinned_at INTEGER NOT NULL => pinned_at INTEGER')
    check(
      'a change to an applied migration fails, before anything goes live',
      migrated.state === 'failed' && migrated.text.includes('Migration 0 differs'),
      migrated.state,
    )
    const untested = await prompt('replace stale/extension.ts :: label: `Stale  => label: `Old ')
    check(
      'a change its extension’s own tests reject fails, with the failing test',
      untested.state === 'failed' && untested.text.includes('Tests failed') && untested.text.includes("expected 'Old"),
      untested.state,
    )
    check('the chat shows the attempts the agent made', untested.text.includes('attempt 3') && (await ada.page.locator(`#${untested.id} [data-step^="retry-"]`).count()) === 2)
    await ada.page.click('#section-changes')
    await ada.page.waitForSelector('#workshop-runs')
    check(
      'Changes lists every run, with its conversation',
      (await ada.page.getAttribute(`#${daily.id}`, 'data-state')) === 'undone' && (await ada.page.locator(`#open-chat-${runId}`).count()) === 1,
    )
  } else {
    console.log('SKIP changes by prompt (start the server with JELLYWARE_AGENT=script)')
  }

  // A swapped extension's open page loses its stream once and reconnects
  // (standup and activity swap their files, triage its settings): not an
  // error. The island probe's blocked fetch is the sandbox working.
  const errors = people.flatMap(person => person.errors).filter(error => !error.includes('/_hyper/standup/') && !error.includes('/_hyper/triage/') && !error.includes('/_hyper/activity/') && !(error.includes('Content Security Policy') && error.includes('/team/ENG')))
  check('no errors in the browser console', errors.length === 0, errors.slice(0, 3).join(' | '))
} finally {
  await browser.close()
  try {
    renameSync(parked, folder)
  } catch {
    // Not parked.
  }
  writeFileSync(pageFile, original)
  if (readFileSync(entryFile, 'utf8') !== originalEntry) writeFileSync(entryFile, originalEntry)
  if (readFileSync(calendarFile, 'utf8') !== originalCalendar) writeFileSync(calendarFile, originalCalendar)
  rmSync(parked, { recursive: true, force: true })
}

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
