import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer, Stream } from 'effect'
import { Story } from 'foldkit/test'

import { openPage, serve } from '@hyper-effect/core/testing'
import { Changes, Contributions, type ExtensionStatus, Extensions, type Run, UndoRefused } from '@hyper-effect/jellyware'

import { USER_COOKIE_NAME, cookieValue } from '@/app/auth'
import { SEED_MEMBERS } from '@/app/seed'
import * as Store from '@/app/store'
import * as Workshop from '@/app/workshop/page'

/* The workshop page: prompts start runs, undo only for installed runs, and
   the page renders runs and extensions. */

const ada = SEED_MEMBERS[0]!

const run = (id: string, state: Run['state']): Run => ({
  id,
  prompt: 'Add a page',
  author: 'Ada',
  startedAt: Date.UTC(2026, 10, 23, 12),
  finishedAt: null,
  state,
  attempts: 1,
  changes: [{ id: 'standup', action: 'changed', before: 'a', after: 'b' }],
  summary: 'Added the page.',
  error: state === 'failed' ? 'standup/page.ts(3,1): error TS2322' : null,
})

const standup: ExtensionStatus = { id: 'standup', name: 'Stand-up', version: '1', state: 'active', running: 1, error: null }

const model = (runs: ReadonlyArray<Run> = []): Workshop.Model =>
  Workshop.init({ shell: { me: ada, counts: { my: 0, ENG: 0, DES: 0 }, nav: [] }, runs, extensions: [standup] }).model

const { Command } = Story

describe('workshop: update (Story)', () => {
  it('starts a run with the prompt and clears the field', () => {
    Story.story(
      Workshop.update,
      Story.given(model()),
      Story.message(Workshop.Message.SubmittedPrompt()),
      Story.model(next => assert.strictEqual(next.notice, 'Describe the change first.')),
      Story.message(Workshop.Message.ChangedPrompt({ text: '  Add a stand-up page  ' })),
      Story.message(Workshop.Message.SubmittedPrompt()),
      Command.expectExact(Workshop.StartRun({ prompt: 'Add a stand-up page', author: ada.name })),
      Story.model(next => {
        assert.strictEqual(next.prompt, '')
        assert.isNull(next.notice)
      }),
      Command.resolve(Workshop.StartRun, Workshop.Message.SucceededStart()),
    )
  })

  it('undoes only installed runs, whatever a browser posts', () => {
    Story.story(
      Workshop.update,
      Story.given(model([run('one', 'installed'), run('two', 'failed')])),
      Story.message(Workshop.Message.ClickedUndo({ runId: 'two' })),
      Story.message(Workshop.Message.ClickedUndo({ runId: 'unknown' })),
      Story.message(Workshop.Message.ClickedUndo({ runId: 'one' })),
      Command.expectExact(Workshop.UndoRun({ runId: 'one' })),
      Command.resolve(Workshop.UndoRun, Workshop.Message.FailedUndo({ message: 'standup changed since this run.' })),
      Story.model(next => assert.strictEqual(next.notice, 'standup changed since this run.')),
    )
  })
})

describe('workshop: the page over HTTP', () => {
  const services = Layer.mergeAll(
    Store.layer,
    Contributions.layer,
    Layer.succeed(
      Changes,
      Changes.of({
        changes: Stream.make([run('one', 'installed'), run('two', 'failed')]),
        current: Effect.succeed([run('one', 'installed'), run('two', 'failed')]),
        start: () => Effect.succeed('three'),
        undo: () => Effect.fail(new UndoRefused({ message: 'no' })),
      }),
    ),
    Layer.succeed(
      Extensions,
      Extensions.of({ changes: Stream.make([standup]), current: Effect.succeed([standup]), reload: () => Effect.void }),
    ),
  )

  it('renders runs, their undo, and the loaded extensions', async () => {
    const server = serve(Workshop.program, { path: Workshop.PATH }, undefined, services)
    try {
      const page = await openPage(server.handler, Workshop.PATH, `${USER_COOKIE_NAME}=${cookieValue('Ada')}`)
      assert.strictEqual(page.response.status, 200)
      assert.include(page.html, 'id="run-one"')
      assert.include(page.html, 'id="undo-one"')
      assert.notInclude(page.html, 'id="undo-two"')
      assert.include(page.html, 'error TS2322')
      assert.include(page.html, 'id="extension-standup"')
      assert.include(page.html, 'Manage extensions')
    } finally {
      await server.dispose()
    }
  })
})
