import { chromium } from 'playwright'

/* Browser check: two people (Ada and Grace) in Chromium against a running
   server (npm start, or NODE_ENV=production). It walks every Tier 1 and
   Tier 2 flow: the grouped list, filters and search in the URL, My issues,
   creating an issue, the issue page (title, properties, comments, activity),
   live updates and presence across the two people, the board, and the
   keyboard (c, j/k, Enter, s/p/a, /, Ctrl+K, Ctrl+Enter, Esc).

   Usage: node scripts/check.mjs   (URL=… for another server) */

const base = process.env.URL ?? 'http://localhost:4100'
const TIMEOUT = Number(process.env.CHECK_TIMEOUT ?? 6000)
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}
const until = (page, predicate, arg) =>
  page.waitForFunction(predicate, arg, { timeout: TIMEOUT }).then(() => true, () => false)
const settle = page => page.waitForTimeout(150)

const browser = await chromium.launch()
const people = []
const signIn = async (name, path = '/team/ENG') => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(`${name}: ${error}`))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`${name}: ${message.text()}`)
  })
  await page.goto(`${base}${path}`)
  await page.getByLabel('Your name').fill(name)
  const stream = page.waitForRequest(request => request.url().includes('/stream'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await stream
  await page.waitForFunction(() => document.querySelector('#hyper-keys[data-hyper-keys]') !== null)
  const person = { page, errors }
  people.push(person)
  return person
}
/** Navigates and waits until the page is live (stream open, key bindings rendered). */
const visit = async (page, path) => {
  const stream = page.waitForRequest(request => request.url().includes('/stream'))
  await page.goto(`${base}${path}`)
  await stream
  await page.waitForFunction(() => document.querySelector('#hyper-keys[data-hyper-keys]') !== null)
  await settle(page)
}
const rowsText = page => page.evaluate(() => [...document.querySelectorAll('#issue-list [id^="row-"]')].map(row => row.id.slice(4)))

try {
  const ada = await signIn('Ada')
  const grace = await signIn('Grace')

  // LIST
  const groups = await ada.page.evaluate(() =>
    [...document.querySelectorAll('#issue-list section')].map(section => ({
      status: section.id.replace('group-', ''),
      count: Number(section.querySelector('[data-count]')?.textContent),
      rows: section.querySelectorAll('[id^="row-"]').length,
    })),
  )
  check('the list is grouped by status with counts', groups.length >= 4 && groups.every(group => group.count === group.rows), JSON.stringify(groups.map(g => `${g.status}:${g.count}`)))
  check('groups follow Linear order (started work first)', groups[0]?.status === 'in_review' && groups.at(-1)?.status === 'canceled')
  const firstRow = ada.page.locator('#issue-list [id^="row-"]').first()
  check('rows show priority, identifier, status, title, labels, assignee and date', await firstRow.evaluate(row =>
    row.querySelector('[aria-label^="Priority"]') !== null &&
    /^[A-Z]+-\d+$/.test(row.id.slice(4)) &&
    row.querySelector('[aria-label^="Status"]') !== null &&
    row.querySelector('[aria-label^="Assign"]') !== null &&
    /[A-Z][a-z]{2} \d+/.test(row.textContent),
  ))

  // SEARCH (in the URL)
  await ada.page.locator('#search').pressSequentially('memory', { delay: 10 })
  check('search narrows the list', await until(ada.page, () => {
    const rows = [...document.querySelectorAll('#issue-list [id^="row-"]')]
    return rows.length === 1 && rows[0].textContent.toLowerCase().includes('memory')
  }))
  check('search is reflected in the URL', await until(ada.page, () => location.search.includes('q=memory')))
  await ada.page.locator('#search').fill('')
  await ada.page.locator('#search').dispatchEvent('input')
  await until(ada.page, () => !location.search.includes('q='))

  // FILTERS (in the URL)
  await ada.page.locator('#filter-button').click()
  await until(ada.page, () => document.activeElement?.id === 'picker-input')
  await ada.page.keyboard.type('in progress', { delay: 10 })
  await settle(ada.page)
  await ada.page.keyboard.press('Enter')
  check('a status filter shows only that status', await until(ada.page, () => {
    const rows = [...document.querySelectorAll('#issue-list [id^="row-"]')]
    return rows.length > 0 && rows.every(row => row.dataset.status === 'in_progress')
  }))
  check('the filter is reflected in the URL', await until(ada.page, () => location.search.includes('status=in_progress')))
  await ada.page.keyboard.press('Escape')
  await until(ada.page, () => document.querySelector('#picker') === null)
  await ada.page.reload()
  await ada.page.waitForFunction(() => document.querySelector('#hyper-keys[data-hyper-keys]') !== null)
  check('a filtered URL opens filtered', await until(ada.page, () =>
    document.querySelector('[data-filter="status"]') !== null &&
    [...document.querySelectorAll('#issue-list [id^="row-"]')].every(row => row.dataset.status === 'in_progress'),
  ))
  await ada.page.getByRole('button', { name: 'Remove Status filter' }).click()
  check('removing the filter clears it from the URL', await until(ada.page, () => !location.search.includes('status=')))

  // MY ISSUES
  await visit(ada.page, '/my-issues')
  check('My issues shows only my issues', await until(ada.page, () => {
    const rows = [...document.querySelectorAll('#issue-list [id^="row-"]')]
    return rows.length > 0 && rows.every(row => row.querySelector('[aria-label="Assignee: Ada Lovelace"]') !== null)
  }))
  await visit(ada.page, '/team/ENG')

  // The sidebar moves between list scopes within the session: no page load,
  // the same session, and back returns to the team.
  await settle(ada.page)
  const sessionBefore = await ada.page.evaluate(() => {
    window.hyperCheckMarker = true
    return document.getElementById('hyper-control')?.getAttribute('data-hyper-endpoint')
  })
  await ada.page.locator('nav a[href="/my-issues"]').first().click()
  check('a sidebar link moves to My issues within the session', await ada.page.waitForURL('**/my-issues', { timeout: TIMEOUT }).then(() => true, () => false) && await until(ada.page, () => {
    const rows = [...document.querySelectorAll('#issue-list [id^="row-"]')]
    return rows.length > 0 && rows.every(row => row.querySelector('[aria-label="Assignee: Ada Lovelace"]') !== null)
  }) && await ada.page.evaluate(endpoint => window.hyperCheckMarker === true && document.getElementById('hyper-control')?.getAttribute('data-hyper-endpoint') === endpoint, sessionBefore))
  await ada.page.goBack()
  check('back returns to the team list in the same session', await ada.page.waitForURL('**/team/ENG', { timeout: TIMEOUT }).then(() => true, () => false) && await until(ada.page, () => document.querySelector('#issue-list [id^="row-ENG-"]') !== null && document.querySelector('#issue-list [id^="row-DES-"]') === null && window.hyperCheckMarker === true))

  // An issue page, then back: the list is a fresh page (never a cached copy
  // replaying the old session's event numbers), so shortcuts still work.
  await ada.page.keyboard.press('j')
  await settle(ada.page)
  await ada.page.keyboard.press('Enter')
  await ada.page.waitForURL('**/issue/**', { timeout: TIMEOUT })
  await settle(ada.page)
  const reopened = ada.page.waitForRequest(request => request.url().includes('/stream'))
  await ada.page.goBack()
  await reopened
  await settle(ada.page)
  await ada.page.keyboard.press('j')
  await ada.page.keyboard.press('s')
  check('after an issue page and back, s opens the status picker', await until(ada.page, () => document.activeElement?.id === 'picker-input'))
  await ada.page.keyboard.press('Escape')
  await until(ada.page, () => document.querySelector('#picker') === null)

  // CREATE ISSUE
  await ada.page.keyboard.press('c')
  check('c opens the new issue dialog with the title focused', await until(ada.page, () => document.activeElement?.id === 'draft-title'))
  await ada.page.locator('#draft-submit').click()
  check('an empty title is refused', await until(ada.page, () => document.querySelector('#draft-title-error')?.textContent?.includes('Give the issue a title')))
  const title = `Checkout fails for EU cards ${Date.now() % 100000}`
  await ada.page.locator('#draft-title').pressSequentially(title, { delay: 5 })
  await ada.page.locator('#draft-priority').click()
  await until(ada.page, () => document.activeElement?.id === 'picker-input')
  await ada.page.keyboard.type('high', { delay: 10 })
  await settle(ada.page)
  await ada.page.keyboard.press('Enter')
  await until(ada.page, () => document.querySelector('#draft-priority')?.textContent?.includes('High'))
  await ada.page.locator('#draft-labels').click()
  await until(ada.page, () => document.activeElement?.id === 'picker-input')
  await ada.page.getByRole('option', { name: 'Bug' }).click()
  await until(ada.page, () => document.querySelector('#draft-labels')?.textContent?.includes('Bug'))
  await ada.page.keyboard.press('Escape')
  await until(ada.page, () => document.querySelector('#picker') === null)
  await ada.page.locator('#draft-description').fill('Cards issued in the EU are declined at the 3-D Secure step.')
  await ada.page.locator('#draft-description').press('Control+Enter')
  check('Ctrl+Enter creates the issue and confirms it', await until(ada.page, () => document.querySelector('#toast')?.textContent?.includes('Created')))
  const created = await ada.page.evaluate(() => document.querySelector('#toast')?.textContent?.match(/[A-Z]+-\d+/)?.[0])
  check('the new issue appears in the list with its properties', await until(ada.page, id => {
    const row = document.querySelector(`#row-${id}`)
    return row?.dataset.status === 'todo' && row.querySelector('[aria-label="Priority: High"]') !== null && row.textContent.includes('Bug')
  }, created), created)
  check("it appears live in the other person's list", await until(grace.page, id => document.querySelector(`#row-${id}`) !== null, created))

  // ISSUE PAGE + PRESENCE
  await ada.page.locator(`#row-${created} a`).click()
  await ada.page.waitForURL(`**/issue/${created}`)
  await ada.page.waitForFunction(() => document.querySelector('#hyper-keys[data-hyper-keys]') !== null)
  await visit(grace.page, `/issue/${created}`)
  check('the issue page shows title, description and properties', await until(ada.page, text =>
    document.querySelector('#issue-title')?.value === text &&
    document.querySelector('#issue-description')?.value.includes('3-D Secure') &&
    document.querySelector('#property-priority')?.textContent.includes('High'), title))
  check('presence: each sees the other viewing', (await until(ada.page, () => document.querySelector('#viewers')?.textContent?.includes('Grace'))) && (await until(grace.page, () => document.querySelector('#viewers')?.textContent?.includes('Ada'))))

  // Edit the title.
  const newTitle = `${title} (3DS)`
  await ada.page.locator('#issue-title').click()
  await ada.page.locator('#issue-title').press('End')
  await ada.page.locator('#issue-title').pressSequentially(' (3DS)', { delay: 10 })
  await ada.page.locator('#issue-title').press('Enter')
  check("a title edit reaches the other person's page", await until(grace.page, text => document.querySelector('#issue-title')?.value === text, newTitle))
  check('the title edit is in the activity log', await until(grace.page, () => [...document.querySelectorAll('#activity [data-kind="title"]')].length === 1))

  // Description, saved when the field loses focus.
  await grace.page.locator('#issue-description').click()
  await grace.page.locator('#issue-description').press('End')
  await grace.page.locator('#issue-description').pressSequentially(' Only Visa.', { delay: 5 })
  await grace.page.locator('#comment-input').click()
  check('a description edit is saved on blur and shows for the other person', await until(ada.page, () => document.querySelector('#issue-description')?.value.endsWith('Only Visa.')))

  // Properties through the picker (mouse) and the keyboard (s, a).
  await grace.page.locator('#property-status').click()
  await until(grace.page, () => document.activeElement?.id === 'picker-input')
  await grace.page.keyboard.type('progress', { delay: 10 })
  await settle(grace.page)
  await grace.page.keyboard.press('Enter')
  check('a status change from the properties panel shows live for the other person', await until(ada.page, () => document.querySelector('#property-status')?.textContent?.includes('In Progress')))
  check('the status change is logged with who did it', await until(ada.page, () => [...document.querySelectorAll('#activity [data-kind="status"]')].some(item => item.textContent.includes('Grace Hopper changed status from Todo to In Progress'))))
  await ada.page.locator('#issue-title').blur()
  await ada.page.locator('body').click({ position: { x: 700, y: 820 } })
  await ada.page.keyboard.press('a')
  await until(ada.page, () => document.activeElement?.id === 'picker-input')
  await ada.page.keyboard.type('grace', { delay: 10 })
  await settle(ada.page)
  await ada.page.keyboard.press('Enter')
  check('a assigns from the keyboard; the other page shows it', await until(grace.page, () => document.querySelector('#property-assignee')?.textContent?.includes('Grace Hopper')))

  // Comments.
  await ada.page.locator('#comment-submit').click()
  check('an empty comment is refused', await until(ada.page, () => document.querySelector('#comment-error')?.textContent?.includes('Write something')))
  await ada.page.locator('#comment-input').pressSequentially('Repro on staging with a Visa test card.', { delay: 5 })
  await ada.page.locator('#comment-input').press('Control+Enter')
  check("a comment shows on the other person's page", await until(grace.page, () => document.querySelector('#activity')?.textContent?.includes('Repro on staging with a Visa test card.')))
  check('the comment box is cleared after posting', await until(ada.page, () => document.querySelector('#comment-input')?.value === ''))

  // Live list: a change on the issue page moves the row on the other person's list.
  await visit(grace.page, '/team/ENG')
  // Shortcuts are off while typing in a field (Foldkit's keyBindings default).
  await ada.page.locator('#comment-input').blur()
  await ada.page.keyboard.press('s')
  await until(ada.page, () => document.activeElement?.id === 'picker-input')
  await ada.page.keyboard.press('5')
  check('a status set with a number key moves the row live in the other list', await until(grace.page, id => document.querySelector(`#group-done #row-${id}`) !== null, created))

  // KEYBOARD ON THE LIST
  await visit(ada.page, '/team/ENG')
  await ada.page.keyboard.press('j')
  await ada.page.keyboard.press('j')
  const selected = await ada.page.evaluate(() => new Promise(resolve => setTimeout(() => resolve(document.querySelector('[data-selected="true"]')?.id.slice(4)), 400)))
  const order = await rowsText(ada.page)
  check('j/k moves the selection', selected === order[1], `${selected}`)
  await ada.page.keyboard.press('k')
  check('k moves it back', await until(ada.page, id => document.querySelector('[data-selected="true"]')?.id === `row-${id}`, order[0]))
  await ada.page.keyboard.press('p')
  await until(ada.page, () => document.activeElement?.id === 'picker-input')
  await ada.page.keyboard.press('4')
  check('p sets the priority of the selected issue', await until(ada.page, id => document.querySelector(`#row-${id} [aria-label="Priority: Low"]`) !== null, order[0]))
  await ada.page.keyboard.press('/')
  check('/ focuses the search', await until(ada.page, () => document.activeElement?.id === 'search'))
  await ada.page.keyboard.press('Escape')
  await ada.page.locator('#search').blur()
  await ada.page.keyboard.press('Control+k')
  check('Ctrl+K opens the command palette', await until(ada.page, () => document.querySelector('#picker[data-field="command"]') !== null && document.activeElement?.id === 'picker-input'))
  await ada.page.keyboard.type('board layout', { delay: 10 })
  await settle(ada.page)
  await ada.page.keyboard.press('Enter')
  check('the palette runs a command (switch to board)', await until(ada.page, () => document.querySelector('#column-todo') !== null && location.search.includes('view=board')))

  // BOARD
  await visit(grace.page, '/team/ENG?view=board')
  const card = await ada.page.evaluate(() => document.querySelector('#column-todo [id^="row-"]')?.id.slice(4))
  await ada.page.locator(`#row-${card} [aria-label^="Status"]`).click()
  await until(ada.page, () => document.activeElement?.id === 'picker-input')
  await ada.page.getByRole('option', { name: 'In Review' }).click()
  check('moving a card to another column (status menu)', await until(ada.page, id => document.querySelector(`#column-in_review #row-${id}`) !== null, card))
  check("the card moves on the other person's board", await until(grace.page, id => document.querySelector(`#column-in_review #row-${id}`) !== null, card))

  // Drag and drop (native HTML5 drag events, bound on the server).
  const dragged = await ada.page.evaluate(() => document.querySelector('#column-backlog [id^="row-"]')?.id.slice(4))
  await ada.page.locator(`#row-${dragged}`).dragTo(ada.page.locator('#column-todo'))
  check('dragging a card onto another column moves it', await until(ada.page, id => document.querySelector(`#column-todo #row-${id}`) !== null, dragged), dragged)
  check("the dragged card moves on the other person's board", await until(grace.page, id => document.querySelector(`#column-todo #row-${id}`) !== null, dragged))

  // Enter opens the selected issue.
  await visit(ada.page, '/team/ENG')
  await ada.page.keyboard.press('j')
  await until(ada.page, () => document.querySelector('[data-selected="true"]') !== null)
  const toOpen = await ada.page.evaluate(() => document.querySelector('[data-selected="true"]')?.id.slice(4))
  await ada.page.keyboard.press('Enter')
  check('Enter opens the selected issue', await ada.page.waitForURL(`**/issue/${toOpen}`, { timeout: TIMEOUT }).then(() => true, () => false))
  await ada.page.waitForFunction(() => document.querySelector('#hyper-keys[data-hyper-keys]') !== null)
  await settle(ada.page)
  await ada.page.keyboard.press('Escape')
  check('Esc on an issue goes back to its list', await ada.page.waitForURL('**/team/ENG', { timeout: TIMEOUT }).then(() => true, () => false))

  // j moves the selection in the page itself (a local effect), before the
  // server has seen the key; the server then agrees.
  await ada.page.waitForFunction(() => document.querySelector('#hyper-keys[data-hyper-keys]') !== null)
  await settle(ada.page)
  const moved = await ada.page.evaluate(() => {
    const before = document.querySelector('#issue-list [data-selected="true"]')?.id
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }))
    const after = document.querySelector('#issue-list [data-selected="true"]')?.id
    return after !== undefined && after !== before ? after : undefined
  })
  check('j moves the selection before the server answers', moved !== undefined)
  await settle(ada.page)
  check('the server agrees with the moved selection', await ada.page.evaluate(id => document.querySelector('#issue-list [data-selected="true"]')?.id === id, moved))

  // ? opens the shortcuts dialog: a styled crease dialog whose ShowDialog
  // runs in the page and replies to the server.
  await ada.page.focus('#layout-list')
  await ada.page.keyboard.press('Shift+?')
  check('? opens the styled shortcuts dialog with focus inside', await until(ada.page, () => document.querySelector('#shortcuts-help')?.open === true && document.activeElement?.closest('#shortcuts-help') != null))
  check('the rest of the page is inert while it is open', await ada.page.evaluate(() => document.querySelector('#issue-list')?.closest('[inert]') != null))
  await ada.page.keyboard.press('Escape')
  check('Esc closes it and the page is usable again', await until(ada.page, () => document.querySelector('#shortcuts-help')?.open === false && document.querySelector('[inert]') === null))
  check('focus returns to what had it before the dialog opened', await until(ada.page, () => document.activeElement?.id === 'layout-list'))

  // The ⋯ menu (crease dropdown-menu, activateOnHover: false): hover is CSS,
  // so moving over its items sends nothing; choosing an item works.
  await visit(ada.page, `/issue/${toOpen}`)
  await ada.page.getByRole('button', { name: 'Issue actions' }).click()
  await ada.page.getByRole('menuitem', { name: 'Back to list' }).waitFor({ timeout: TIMEOUT })
  let hoverPosts = 0
  const countPost = request => {
    if (request.method() === 'POST') hoverPosts += 1
  }
  ada.page.on('request', countPost)
  for (const name of ['Back to list', 'Delete issue', 'Back to list']) await ada.page.getByRole('menuitem', { name }).hover()
  await ada.page.waitForTimeout(200)
  ada.page.off('request', countPost)
  check('hovering the menu items sends no requests', hoverPosts === 0, `${hoverPosts} posts`)
  await ada.page.keyboard.press('Escape')
  check('Esc closes the menu and focus returns to its trigger', await until(ada.page, () => document.querySelector('[role="menu"]') === null && document.activeElement?.getAttribute('aria-label') === 'Issue actions'))
  await ada.page.getByRole('button', { name: 'Issue actions' }).click()
  await ada.page.getByRole('menuitem', { name: 'Back to list' }).waitFor({ timeout: TIMEOUT })
  await ada.page.getByRole('menuitem', { name: 'Back to list' }).click()
  check('a menu item chosen with the pointer works', await ada.page.waitForURL('**/team/ENG', { timeout: TIMEOUT }).then(() => true, () => false))

  // Theme (dark mode follows the person on every open page).
  await ada.page.waitForFunction(() => document.querySelector('#hyper-keys[data-hyper-keys]') !== null)
  await ada.page.locator('#theme-toggle').click()
  check('dark mode', await until(ada.page, () => document.querySelector('#app')?.classList.contains('dark')))
  await ada.page.locator('#theme-toggle').click()
  await until(ada.page, () => !document.querySelector('#app')?.classList.contains('dark'))

  const errors = people.flatMap(person => person.errors)
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))
} finally {
  await browser.close()
}

const failed = results.filter(result => !result.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
