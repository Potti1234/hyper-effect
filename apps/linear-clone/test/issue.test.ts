import { assert, describe, it } from '@effect/vitest'
import { Story } from 'foldkit/test'

import { openPage, openStream, postEvent, readUntil, serve, token } from '@hyper-effect/core/testing'

import { USER_COOKIE_NAME, cookieValue } from '@/app/auth'
import * as IssuePage from '@/app/issue/page'
import { SEED_MEMBERS, seed } from '@/app/seed'
import * as Store from '@/app/store'

/* The issue page: inline edits, properties, comments and what happens when
   someone else deletes the issue. */

const NOW = Date.UTC(2026, 9, 27, 12)
const seeded = seed(NOW)
const ada = SEED_MEMBERS[0]!
const target = seeded.issues.find(issue => issue.identifier === 'ENG-13')!

const model = (): IssuePage.Model =>
  IssuePage.init({
    me: ada,
    identifier: target.identifier,
    issue: target,
    members: SEED_MEMBERS,
    comments: seeded.comments.filter(comment => comment.issueId === target.id),
    activity: seeded.activity.filter(entry => entry.issueId === target.id),
    counts: { my: 0, ENG: 0, DES: 0 },
  }).model

const { Command } = Story

describe('issue: update (Story)', () => {
  it('saves a title edit and keeps the draft until it is saved', () => {
    Story.story(
      IssuePage.updateModel,
      Story.given(model()),
      Story.message(IssuePage.Message.ChangedTitle({ title: '   ' })),
      Story.message(IssuePage.Message.SubmittedTitle()),
      Story.model(next => assert.strictEqual(next.titleError, 'Give the issue a title.')),
      Story.message(IssuePage.Message.ChangedTitle({ title: ' Memory leak in the gateway ' })),
      Story.message(IssuePage.Message.SubmittedTitle()),
      Command.expectExact(
        IssuePage.SaveIssue({ changes: [{ id: target.id, patch: { title: 'Memory leak in the gateway' } }], actorId: 'ada', field: 'title' }),
      ),
      // Until the save is done the field keeps what was typed (no flash of the old title).
      Story.model(next => assert.strictEqual(next.titleDraft, ' Memory leak in the gateway ')),
      Command.resolve(IssuePage.SaveIssue, IssuePage.Message.SucceededSaveTitle()),
      Story.model(next => assert.isNull(next.titleDraft)),
    )
  })

  it('does not save an unchanged title (blur without edits)', () => {
    Story.story(
      IssuePage.updateModel,
      Story.given(model()),
      Story.message(IssuePage.Message.SubmittedTitle()),
      Story.message(IssuePage.Message.ChangedTitle({ title: target.title })),
      Story.message(IssuePage.Message.SubmittedTitle()),
      Story.model(next => assert.isNull(next.titleDraft)),
      Command.expectNone(),
    )
  })

  it('posts a comment, refusing an empty one', () => {
    Story.story(
      IssuePage.updateModel,
      Story.given(model()),
      Story.message(IssuePage.Message.SubmittedComment()),
      Story.model(next => assert.strictEqual(next.commentError, 'Write something first.')),
      Story.message(IssuePage.Message.ChangedComment({ text: 'Looks good to me.' })),
      // Ctrl+Enter in the comment box, reported by the keyboard island.
      Story.message(IssuePage.Message.PressedShortcut({ shortcut: 'submit', targetId: 'comment-input' })),
      Command.expectExact(IssuePage.PostComment({ issueId: target.id, body: 'Looks good to me.', authorId: 'ada' })),
      Command.resolve(IssuePage.PostComment, IssuePage.Message.SucceededPostComment()),
      Story.model(next => {
        assert.strictEqual(next.comment, '')
        assert.isFalse(next.isPosting)
      }),
    )
  })

  it('changes properties through the picker and refuses made-up values', () => {
    Story.story(
      IssuePage.updateModel,
      Story.given(model()),
      Story.message(IssuePage.Message.ClickedOpenPicker({ field: 'assignee', anchor: '--anchor-detail-assignee' })),
      Story.message(IssuePage.Message.ClickedPickerItem({ value: 'mallory' })),
      Command.expectNone(),
      Story.message(IssuePage.Message.ClickedPickerItem({ value: 'none' })),
      Story.model(next => assert.isNull(next.picker)),
      Command.expectExact(IssuePage.SaveIssue({ changes: [{ id: target.id, patch: { assigneeId: null } }], actorId: 'ada', field: 'property' })),
      Command.resolve(IssuePage.SaveIssue, IssuePage.Message.CompletedChange()),
      // A field this page has no picker for.
      Story.message(IssuePage.Message.ClickedOpenPicker({ field: 'command', anchor: null })),
      Story.model(next => assert.isNull(next.picker)),
    )
  })

  it('shows that the issue was deleted by someone else', () => {
    Story.story(
      IssuePage.updateModel,
      Story.given(model()),
      Story.message(IssuePage.Message.ClickedOpenPicker({ field: 'status', anchor: null })),
      Story.message(IssuePage.Message.GotIssue({ issue: null, members: SEED_MEMBERS, comments: [], activity: [], counts: { my: 0, ENG: 0, DES: 0 } })),
      Story.model(next => {
        assert.isNull(next.issue)
        assert.isNull(next.picker)
      }),
    )
  })

  it('goes back to the list with Escape', () => {
    Story.story(
      IssuePage.updateModel,
      Story.given(model()),
      Story.message(IssuePage.Message.PressedShortcut({ shortcut: 'escape', targetId: '' })),
      Command.expectExact(IssuePage.LoadUrl({ url: '/team/ENG' })),
      Command.resolve(IssuePage.LoadUrl, IssuePage.Message.CompletedBrowserAction()),
    )
  })
})

describe('issue: the page over HTTP', () => {
  const cookie = `${USER_COOKIE_NAME}=${cookieValue('Ada')}`
  const served = () => serve(IssuePage.program, { path: '/issue/:identifier' }, undefined, Store.layer)

  it('answers 404 for an unknown issue', async () => {
    const server = served()
    try {
      const response = await server.handler(new Request('http://localhost/issue/ENG-999', { headers: { cookie } }))
      assert.strictEqual(response.status, 404)
    } finally {
      await server.dispose()
    }
  })

  it('renders the issue with its comments and activity', async () => {
    const server = served()
    try {
      const page = await openPage(server.handler, '/issue/eng-13', cookie)
      assert.include(page.html, 'Memory leak in the realtime gateway')
      assert.include(page.html, 'Confirmed on staging')
      assert.include(page.html, 'changed status from Todo to In Progress')
      assert.include(page.html, 'id="property-status"')
    } finally {
      await server.dispose()
    }
  })

  it('posts a comment typed into the box', async () => {
    const server = served()
    try {
      const page = await openPage(server.handler, '/issue/ENG-13', cookie)
      const handler =
        page.html.match(/id="comment-input"[^>]*data-hyper-input="([^"]+)"/)?.[1] ??
        page.html.match(/data-hyper-input="([^"]+)"[^>]*id="comment-input"/)?.[1]
      assert.isDefined(handler)
      assert.strictEqual((await postEvent(server.handler, page, { h: handler, v: 'Deployed the fix to staging.', q: 1 })).status, 204)
      assert.strictEqual((await postEvent(server.handler, page, { m: token({ _tag: 'SubmittedComment' }), q: 2 })).status, 204)
      const stream = await readUntil(await openStream(server.handler, page), 'Deployed the fix to staging.')
      assert.include(stream, 'Deployed the fix to staging.')
    } finally {
      await server.dispose()
    }
  })
})
