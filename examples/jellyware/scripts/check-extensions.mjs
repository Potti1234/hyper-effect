import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

/* Browser check of extensions against a running server (npm start, with
   extensions reloaded on change, the default): the Stand-up extension's
   sidebar entry and page, a new version of it swapped in while the page is
   open, and the extension unloaded and loaded again while another person's
   page shows the sidebar.

   Then roles on /extensions: Ada administers, Grace only looks until Ada
   gives her the role.

   The last part changes the app by prompt on /extensions: a run waits for
   review, Ada reads the diff and approves it. It needs the server started
   with JELLYWARE_AGENT=script (a scripted agent instead of pi); without
   it, that part is skipped.

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

  // ROLES
  await grace.page.goto(`${base}/extensions`)
  await grace.page.waitForSelector('#workshop-members')
  check(
    'a member sees who may change the app, and no prompt',
    (await grace.page.textContent('#workshop-form')).includes('Only administrators') && (await grace.page.locator('#workshop-prompt').count()) === 0,
  )
  check('nor settings buttons', (await grace.page.locator('#workshop-extensions button[id^="settings-"]').count()) === 0)
  await ada.page.goto(`${base}/extensions`)
  await ada.page.waitForSelector('#role-grace')
  await ada.page.click('#role-grace')
  check('an administrator gives the role, and the member’s open page follows', await until(grace.page, () => document.querySelector('#workshop-prompt') !== null))
  check('with the settings buttons', await until(grace.page, () => document.querySelector('#settings-related') !== null))
  await ada.page.click('#role-grace')
  check('and takes it back', await until(grace.page, () => document.querySelector('#workshop-prompt') === null))

  // CHANGES BY PROMPT
  if (process.env.JELLYWARE_AGENT === 'script') {
    await ada.page.goto(`${base}/extensions`)
    await ada.page.waitForSelector('#workshop-extensions')
    check('the workshop lists the loaded extension', await until(ada.page, () => document.querySelector('#extension-standup')?.dataset.state === 'active'))
    const prompt = async text => {
      const before = await ada.page.locator('#workshop-runs article').count()
      await ada.page.fill('#workshop-prompt', text)
      await ada.page.click('#workshop-submit')
      await ada.page.waitForFunction(count => document.querySelectorAll('#workshop-runs article').length > count, before, { timeout: TIMEOUT })
      const id = await ada.page.evaluate(() => document.querySelector('#workshop-runs article').id)
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
    const rejected = await prompt("replace standup/extension.ts :: label: 'Stand-up' => label: 'Never'")
    await ada.page.click(`#reject-${rejected.id.slice(4)}`)
    check('a rejected run changes nothing', await until(ada.page, selector => document.querySelector(selector)?.dataset.state === 'rejected', `#${rejected.id}`))
    check('and stays out of the sidebar', ![...(await grace.page.$$eval('#sidebar a', links => links.map(link => link.textContent)))].includes('Never'))
    const liveBefore = readFileSync(pageFile, 'utf8')
    const broken = await prompt("replace standup/page.ts :: export const PATH = '/standup' => export const PATH: number = '/standup'")
    check('a change that does not typecheck fails', broken.state === 'failed' && broken.text.includes('TS2322'), broken.state)
    check('and leaves the live extension alone', readFileSync(pageFile, 'utf8') === liveBefore)
  } else {
    console.log('SKIP changes by prompt (start the server with JELLYWARE_AGENT=script)')
  }

  const errors = people.flatMap(person => person.errors).filter(error => !error.includes('/_hyper/standup/'))
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
  rmSync(parked, { recursive: true, force: true })
}

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
