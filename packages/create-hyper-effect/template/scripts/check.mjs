import { chromium } from 'playwright'

/* Browser check: two people on the task list, in Chromium, against a running
   server (npm start). Extend it with every feature you add; unit tests do
   not see what only a browser does (morphs, focus, typing while the page
   updates).

   Usage: node scripts/check.mjs   (URL=… for another server) */

const base = process.env.URL ?? 'http://localhost:4000'
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}
const until = (page, predicate, arg) =>
  page.waitForFunction(predicate, arg, { timeout: 5000 }).then(() => true, () => false)

const browser = await chromium.launch()
const signIn = async name => {
  const page = await (await browser.newContext()).newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto(`${base}/`)
  await page.getByLabel('Your name').fill(name)
  const stream = page.waitForRequest(request => request.url().includes('/stream'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await stream
  return { page, errors }
}

try {
  const ada = await signIn('Ada')
  const bob = await signIn('Bob')
  check('signing in shows the task list', (await ada.page.locator('#task-list li').count()) >= 1)

  // Type and press Enter at once: the typed text travels with the submit.
  const title = `Check task ${Date.now() % 10000}`
  await ada.page.getByLabel('New task').pressSequentially(title, { delay: 5 })
  await ada.page.getByLabel('New task').press('Enter')
  check('a task typed and submitted at once is added', await until(ada.page, text => document.querySelector('#task-list')?.textContent?.includes(text), title))
  check('the form is cleared after adding', await until(ada.page, () => document.querySelector('#task-title')?.value === ''))
  check("the other person's page shows it live", await until(bob.page, text => document.querySelector('#task-list')?.textContent?.includes(text), title))

  // A page-wide shortcut: N focuses the new-task input (a key binding, then
  // a forwarded focus).
  await ada.page.locator('body').click({ position: { x: 5, y: 300 } })
  await ada.page.keyboard.press('n')
  check('N focuses the new-task input', await until(ada.page, () => document.activeElement?.id === 'task-title'))
  await ada.page.keyboard.type('x')
  check('typing there does not trigger the shortcut again', (await ada.page.getByLabel('New task').inputValue()) === 'x')
  await ada.page.getByLabel('New task').fill('')

  await ada.page.getByRole('button', { name: 'Add', exact: true }).click()
  check('an empty title is refused with a message', await until(ada.page, () => document.querySelector('#new-task')?.textContent?.includes('Describe the task.')))

  await bob.page.getByRole('button', { name: `Done: ${title}` }).click()
  check('marking it done shows on both pages', await until(ada.page, text => document.querySelector(`[aria-label="Done: ${text}"]`)?.getAttribute('aria-pressed') === 'true', title))

  await ada.page.getByRole('button', { name: 'Done', exact: true }).click()
  check('the Done filter shows done tasks only', await until(ada.page, () => [...document.querySelectorAll('#task-list li')].every(li => li.textContent.includes('✓'))))
  await ada.page.getByRole('button', { name: 'All', exact: true }).click()

  await ada.page.getByRole('button', { name: `Remove ${title}` }).click()
  check('removing it removes it everywhere', await until(bob.page, text => !document.querySelector('#task-list')?.textContent?.includes(text), title))
  check('no page errors', ada.errors.length + bob.errors.length === 0, [...ada.errors, ...bob.errors].slice(0, 2).join(' | '))
} finally {
  await browser.close()
}

const failed = results.filter(result => !result.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
