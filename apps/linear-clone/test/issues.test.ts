import { assert, describe, it } from '@effect/vitest'
import { Story } from 'foldkit/test'

import { openPage, openStream, postEvent, readUntil, serve, token } from '@hyper-effect/core/testing'

import { USER_COOKIE_NAME, cookieValue } from '@/app/auth'
import { type Issue, emptyQuery, queryFromUrl, searchForQuery } from '@/app/domain'
import * as Issues from '@/app/issues/page'
import { SEED_MEMBERS, seed } from '@/app/seed'
import * as Store from '@/app/store'

/* The issue list: update as a pure function (Foldkit's Story, Commands
   resolved by hand), then the page over HTTP as a browser drives it. */

const NOW = Date.UTC(2026, 9, 27, 12)
const seeded = seed(NOW)
const ada = SEED_MEMBERS[0]!
const issue = (identifier: string): Issue => seeded.issues.find(candidate => candidate.identifier === identifier)!

const model = (overrides: Partial<Issues.Model> = {}): Issues.Model => ({
  ...Issues.init({
    me: ada,
    scope: { _tag: 'Team', team: 'ENG' },
    query: emptyQuery,
    members: SEED_MEMBERS,
    issues: seeded.issues,
    isCreating: false,
  }).model,
  ...overrides,
})

const { Command } = Story

describe('issues: update (Story)', () => {
  it('validates and creates an issue, then confirms it', () => {
    Story.story(
      Issues.updateModel,
      Story.given(model()),
      Story.message(Issues.Message.ClickedCreate({ status: 'in_progress' })),
      Story.model(next => {
        assert.strictEqual(next.draft?.status, 'in_progress')
        assert.strictEqual(next.draft?.team, 'ENG')
        assert.strictEqual(next.focus?.selector, '#draft-title')
      }),
      Story.message(Issues.Message.ChangedDraftTitle({ title: '   ' })),
      Story.message(Issues.Message.SubmittedDraft()),
      Story.model(next => assert.strictEqual(next.draft?.errors['title'], 'Give the issue a title.')),
      Story.message(Issues.Message.ChangedDraftTitle({ title: '  Login loops on Safari ' })),
      Story.message(Issues.Message.SubmittedDraft()),
      Story.model(next => assert.isTrue(next.draft?.isSaving)),
      Command.expectExact(Issues.CreateIssue({
        input: { team: 'ENG', title: 'Login loops on Safari', description: '', status: 'in_progress', priority: 0, assigneeId: null, labelIds: [] },
        actorId: 'ada',
      })),
      Command.resolve(Issues.CreateIssue, Issues.Message.SucceededCreate({ id: 'iss_new', identifier: 'ENG-27' })),
      Story.model(next => {
        assert.isNull(next.draft)
        assert.strictEqual(next.selectedId, 'iss_new')
        assert.strictEqual(next.toast?.text, 'Created ENG-27')
      }),
      Command.resolve(Issues.ExpireToast, Issues.Message.ExpiredToast({ seq: 3 })),
      Story.model(next => assert.isNull(next.toast)),
    )
  })

  it('ignores a second submit while saving (double clicks)', () => {
    const start = model()
    Story.story(
      Issues.updateModel,
      Story.given({ ...start, draft: { team: 'ENG', title: 'A', description: '', status: 'todo', priority: 0, assigneeId: null, labelIds: [], errors: {}, isSaving: true } }),
      Story.message(Issues.Message.SubmittedDraft()),
      Command.expectNone(),
    )
  })

  it('changes a status through the picker, from the keyboard', () => {
    const target = issue('ENG-1') // In Progress
    Story.story(
      Issues.updateModel,
      Story.given(model({ selectedId: target.id })),
      Story.message(Issues.Message.PressedShortcut({ shortcut: 'status', targetId: '' })),
      Story.model(next => {
        assert.strictEqual(next.picker?.field, 'status')
        // It starts on the current value, as Linear does: In Progress is the third status.
        assert.strictEqual(next.picker?.active, 2)
      }),
      Story.message(Issues.Message.PressedPickerKey({ key: 'ArrowDown' })),
      Command.resolve(Issues.ScrollIntoView, Issues.Message.CompletedBrowserAction()),
      Story.message(Issues.Message.PressedPickerKey({ key: 'Enter' })),
      Story.model(next => assert.isNull(next.picker)),
      Command.expectExact(Issues.UpdateIssues({ changes: [{ id: target.id, patch: { status: 'in_review' } }], actorId: 'ada' })),
      Command.resolve(Issues.UpdateIssues, Issues.Message.CompletedChange()),
    )
  })

  it('filters the picker by what is typed and picks with a number key', () => {
    const target = issue('ENG-2')
    Story.story(
      Issues.updateModel,
      Story.given(model()),
      Story.message(Issues.Message.ClickedOpenPicker({ field: 'priority', target: 'issues', issueId: target.id, anchor: '--a' })),
      Story.message(Issues.Message.PressedPickerKey({ key: '4' })),
      Command.expectExact(Issues.UpdateIssues({ changes: [{ id: target.id, patch: { priority: 4 } }], actorId: 'ada' })),
      Command.resolve(Issues.UpdateIssues, Issues.Message.CompletedChange()),
      Story.message(Issues.Message.ClickedOpenPicker({ field: 'assignee', target: 'issues', issueId: target.id, anchor: null })),
      Story.message(Issues.Message.ChangedPickerQuery({ query: 'grace' })),
      Story.message(Issues.Message.PressedPickerKey({ key: 'Enter' })),
      Command.expectExact(Issues.UpdateIssues({ changes: [{ id: target.id, patch: { assigneeId: 'grace' } }], actorId: 'ada' })),
      Command.resolve(Issues.UpdateIssues, Issues.Message.CompletedChange()),
    )
  })

  it('keeps the label picker open and toggles labels', () => {
    const target = issue('ENG-1') // has `bug`
    Story.story(
      Issues.updateModel,
      Story.given(model()),
      Story.message(Issues.Message.ClickedOpenPicker({ field: 'labels', target: 'issues', issueId: target.id, anchor: null })),
      Story.message(Issues.Message.ClickedPickerItem({ value: 'bug' })),
      Story.model(next => assert.strictEqual(next.picker?.field, 'labels')),
      Command.expectExact(Issues.UpdateIssues({ changes: [{ id: target.id, patch: { labelIds: [] } }], actorId: 'ada' })),
      Command.resolve(Issues.UpdateIssues, Issues.Message.CompletedChange()),
    )
  })

  it('refuses what the browser makes up', () => {
    Story.story(
      Issues.updateModel,
      Story.given(model()),
      // An issue that does not exist.
      Story.message(Issues.Message.ClickedOpenPicker({ field: 'status', target: 'issues', issueId: 'nope', anchor: null })),
      Story.model(next => assert.isNull(next.picker)),
      // A value the open picker does not offer.
      Story.message(Issues.Message.ClickedOpenPicker({ field: 'assignee', target: 'issues', issueId: issue('ENG-3').id, anchor: null })),
      Story.message(Issues.Message.ClickedPickerItem({ value: 'mallory' })),
      Story.model(next => assert.strictEqual(next.picker?.field, 'assignee')),
      // A picker item with no picker open.
      Story.message(Issues.Message.ClickedClosePicker()),
      Story.message(Issues.Message.ClickedPickerItem({ value: 'done' })),
      Command.expectNone(),
    )
  })

  it('mirrors filters into the address bar', () => {
    Story.story(
      Issues.updateModel,
      Story.given(model()),
      Story.message(Issues.Message.ClickedOpenPicker({ field: 'filter', target: 'filter', issueId: null, anchor: '--anchor-filter' })),
      Story.message(Issues.Message.ClickedPickerItem({ value: 'status:todo' })),
      Command.expectExact(Issues.ReplaceUrl({ url: '/team/ENG?status=todo' })),
      Command.resolve(Issues.ReplaceUrl, Issues.Message.CompletedBrowserAction()),
      Story.message(Issues.Message.ClickedPickerItem({ value: 'label:bug' })),
      Command.resolve(Issues.ReplaceUrl({ url: '/team/ENG?status=todo&label=bug' }), Issues.Message.CompletedBrowserAction()),
      Story.model(next => {
        assert.deepStrictEqual(next.query.status, ['todo'])
        assert.deepStrictEqual(next.query.label, ['bug'])
        assert.isTrue(Issues.visibleIssues(next).every(item => item.status === 'todo' && item.labelIds.includes('bug')))
      }),
      Story.message(Issues.Message.ClickedClearFilters()),
      Command.resolve(Issues.ReplaceUrl({ url: '/team/ENG' }), Issues.Message.CompletedBrowserAction()),
    )
  })

  it('walks the list with j/k in screen order and opens with Enter', () => {
    const start = model()
    const order = Issues.navigationOrder(start)
    const press = (shortcut: 'down' | 'up' | 'open') => Issues.Message.PressedShortcut({ shortcut, targetId: '' })
    Story.story(
      Issues.updateModel,
      Story.given(start),
      Story.message(press('down')),
      Command.resolve(Issues.ScrollIntoView({ selector: `#row-${order[0]!.identifier}` }), Issues.Message.CompletedBrowserAction()),
      Story.message(press('down')),
      Command.resolve(Issues.ScrollIntoView, Issues.Message.CompletedBrowserAction()),
      Story.model(next => assert.strictEqual(next.selectedId, order[1]!.id)),
      Story.message(press('up')),
      Command.resolve(Issues.ScrollIntoView, Issues.Message.CompletedBrowserAction()),
      Story.message(press('open')),
      Command.expectExact(Issues.LoadUrl({ url: `/issue/${order[0]!.identifier}` })),
      Command.resolve(Issues.LoadUrl, Issues.Message.CompletedBrowserAction()),
    )
    // Started work comes first, as in Linear.
    assert.strictEqual(order[0]!.status, 'in_review')
  })

  it('takes the row the page already moved the selection to', () => {
    const start = model()
    const order = Issues.navigationOrder(start)
    Story.story(
      Issues.updateModel,
      Story.given(start),
      // A local effect moved data-selected; no ScrollIntoView, the page scrolled.
      Story.message(Issues.Message.MovedSelection({ elementId: `row-${order[2]!.identifier}` })),
      Story.model(next => assert.strictEqual(next.selectedId, order[2]!.id)),
      Story.message(Issues.Message.MovedSelection({ elementId: 'row-GONE-1' })),
      Story.model(next => assert.strictEqual(next.selectedId, order[2]!.id)),
    )
  })

  it('moves to another scope within the session', () => {
    Story.story(
      Issues.updateModel,
      Story.given({ ...model(), selectedId: model().issues[0]!.id }),
      Story.message(
        Issues.Message.ChangedUrl({ scope: { _tag: 'Mine' }, query: queryFromUrl(new URL('http://localhost/my-issues?q=crash')) }),
      ),
      Story.model(next => {
        assert.deepStrictEqual(next.scope, { _tag: 'Mine' })
        assert.strictEqual(next.query.search, 'crash')
        assert.isNull(next.selectedId)
      }),
    )
  })

  it('runs palette commands', () => {
    Story.story(
      Issues.updateModel,
      Story.given(model()),
      Story.message(Issues.Message.PressedShortcut({ shortcut: 'palette', targetId: '' })),
      Story.message(Issues.Message.ChangedPickerQuery({ query: 'board' })),
      Story.message(Issues.Message.PressedPickerKey({ key: 'Enter' })),
      Story.model(next => {
        assert.strictEqual(next.query.layout, 'board')
        assert.isNull(next.picker)
      }),
      Command.resolve(Issues.ReplaceUrl({ url: '/team/ENG?view=board' }), Issues.Message.CompletedBrowserAction()),
    )
  })
})

describe('domain: the query in the URL', () => {
  it('round-trips and ignores what it does not know', () => {
    const query = queryFromUrl(new URL('http://x/team/ENG?status=todo,in_progress,bogus&priority=1,9&label=bug,nope&q=crash&view=board'))
    assert.deepStrictEqual(query.status, ['todo', 'in_progress'])
    assert.deepStrictEqual(query.priority, [1])
    assert.deepStrictEqual(query.label, ['bug'])
    assert.strictEqual(searchForQuery(query), '?q=crash&status=todo,in_progress&priority=1&label=bug&view=board')
  })
})

describe('issues: the page over HTTP', () => {
  const cookie = `${USER_COOKIE_NAME}=${cookieValue('Ada')}`
  const served = () => serve(Issues.program, { path: '/team/:team', paths: Issues.paths }, undefined, Store.layer)

  it('sends a signed-out visitor to sign in, and answers 404 for an unknown team', async () => {
    const server = served()
    try {
      const response = await server.handler(new Request('http://localhost/team/ENG'))
      assert.strictEqual(response.status, 303)
      assert.strictEqual(response.headers.get('location'), '/login?next=%2Fteam%2FENG')
      const unknown = await server.handler(new Request('http://localhost/team/XYZ', { headers: { cookie } }))
      assert.strictEqual(unknown.status, 404)
    } finally {
      await server.dispose()
    }
  })

  it('renders the grouped list, filtered from the URL', async () => {
    const server = served()
    try {
      const page = await openPage(server.handler, '/team/ENG', cookie)
      assert.include(page.html, 'id="group-in_review"')
      assert.include(page.html, 'Memory leak in the realtime gateway')
      assert.notInclude(page.html, 'Redesign the empty states') // a DES issue
      const filtered = await openPage(server.handler, '/team/ENG?status=done', cookie)
      assert.include(filtered.html, 'id="group-done"')
      assert.notInclude(filtered.html, 'id="group-todo"')
    } finally {
      await server.dispose()
    }
  })

  it('changes a status through posted events and streams the moved row', async () => {
    const server = served()
    try {
      const page = await openPage(server.handler, '/team/ENG', cookie)
      const open = { _tag: 'ClickedOpenPicker', field: 'status', target: 'issues', issueId: 'iss_1', anchor: null }
      assert.strictEqual((await postEvent(server.handler, page, { m: token(open), q: 1 })).status, 204)
      assert.strictEqual((await postEvent(server.handler, page, { m: token({ _tag: 'ClickedPickerItem', value: 'done' }), q: 2 })).status, 204)
      // The stream sends the morph; a second page shows the change in the store.
      await readUntil(await openStream(server.handler, page), 'Status: Done')
      const other = await openPage(server.handler, '/team/ENG', `${USER_COOKIE_NAME}=${cookieValue('Grace')}`)
      const done = other.html.slice(other.html.indexOf('id="group-done"'), other.html.indexOf('id="group-canceled"'))
      assert.include(done, 'id="row-ENG-1"')
    } finally {
      await server.dispose()
    }
  })

  it('creates an issue typed into the dialog', async () => {
    const server = served()
    try {
      const page = await openPage(server.handler, '/team/ENG?new=1', cookie)
      const handler = page.html.match(/id="draft-title"[^>]*data-hyper-input="([^"]+)"/)?.[1] ?? page.html.match(/data-hyper-input="([^"]+)"[^>]*id="draft-title"/)?.[1]
      assert.isDefined(handler)
      assert.strictEqual((await postEvent(server.handler, page, { h: handler, v: 'Webhooks drop events under load', q: 1 })).status, 204)
      assert.strictEqual((await postEvent(server.handler, page, { m: token({ _tag: 'SubmittedDraft' }), q: 2 })).status, 204)
      const stream = await readUntil(await openStream(server.handler, page), 'Created ENG-27')
      assert.include(stream, 'Webhooks drop events under load')
    } finally {
      await server.dispose()
    }
  })

  it('refuses a Message that is not a ClientMessage', async () => {
    const server = served()
    try {
      const page = await openPage(server.handler, '/team/ENG', cookie)
      // A Command result posted as if it were a click is dropped, not applied.
      await postEvent(server.handler, page, { m: token({ _tag: 'SucceededCreate', id: 'x', identifier: 'ENG-999' }), q: 1 })
      await postEvent(server.handler, page, { m: token({ _tag: 'ClickedCreate', status: null }), q: 2 })
      const stream = await readUntil(await openStream(server.handler, page), 'new-issue-dialog')
      assert.notInclude(stream, 'ENG-999')
    } finally {
      await server.dispose()
    }
  })
})
