import { assert, describe, it } from '@effect/vitest'
import { Story } from 'foldkit/test'

import { openPage, openStream, postEvent, readUntil, serve, token } from '@hyper-effect/core/testing'

import { USER_COOKIE_NAME, cookieValue } from '@/app/auth'
import * as TaskPage from '@/app/tasks/page'
import { Tasks } from '@/app/tasks/store'

/* Two kinds of tests:
   - update is a pure Foldkit function: Foldkit's Story runs Messages through
     it and resolves Commands by hand.
   - The page over HTTP, as a browser drives it: @hyper-effect/core/testing
     serves the program with its services and posts events. */

const model: TaskPage.Model = {
  user: 'ada',
  tasks: [],
  filter: 'all',
  draft: '',
  draftError: null,
  isAdding: false,
  notice: null,
}

describe('tasks: update (Story)', () => {
  it('refuses an empty title and adds a valid one', () => {
    Story.story(
      TaskPage.update,
      Story.given({ ...model, draft: '   ' }),
      Story.message(TaskPage.Message.SubmittedDraft()),
      Story.model(next => assert.strictEqual(next.draftError, 'Describe the task.')),
      Story.message(TaskPage.Message.ChangedDraft({ title: '  Water the plants ' })),
      Story.message(TaskPage.Message.SubmittedDraft()),
      Story.model(next => {
        assert.isNull(next.draftError)
        assert.isTrue(next.isAdding)
      }),
      Story.Command.resolve(TaskPage.AddTask, TaskPage.Message.SucceededAdd()),
      Story.model(next => {
        assert.strictEqual(next.draft, '')
        assert.isFalse(next.isAdding)
      }),
    )
  })

  it('shows why a change failed', () => {
    Story.story(
      TaskPage.update,
      Story.given(model),
      Story.message(TaskPage.Message.ClickedToggle({ id: 'gone' })),
      Story.Command.resolve(TaskPage.ToggleTask, TaskPage.Message.FailedChange({ reason: 'That task was just deleted.' })),
      Story.model(next => assert.strictEqual(next.notice, 'That task was just deleted.')),
    )
  })
})

describe('tasks: the page over HTTP', () => {
  const cookie = `${USER_COOKIE_NAME}=${cookieValue('ada')}`

  it('sends a signed-out visitor to sign in', async () => {
    const server = serve(TaskPage.program, {}, undefined, Tasks.layer)
    try {
      const response = await server.handler(new Request('http://localhost/'))
      assert.strictEqual(response.status, 303)
      assert.strictEqual(response.headers.get('location'), '/login?next=%2F')
    } finally {
      await server.dispose()
    }
  })

  it('adds a task typed into the form', async () => {
    const server = serve(TaskPage.program, {}, undefined, Tasks.layer)
    try {
      const page = await openPage(server.handler, '/', cookie)
      assert.include(page.html, 'Read the README')
      // The input is client-owned: what the user types arrives through its
      // handler, named in the page.
      const handler = page.html.match(/data-hyper-input="([^"]+)"[^>]*id="task-title"/)?.[1]
      assert.isDefined(handler)
      assert.strictEqual((await postEvent(server.handler, page, { h: handler, v: 'Water the plants', q: 1 })).status, 204)
      assert.strictEqual((await postEvent(server.handler, page, { m: token({ _tag: 'SubmittedDraft' }), q: 2 })).status, 204)
      const stream = await readUntil(await openStream(server.handler, page), 'Water the plants')
      assert.include(stream, 'Water the plants')
    } finally {
      await server.dispose()
    }
  })
})
