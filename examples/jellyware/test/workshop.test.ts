import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer, Stream } from 'effect'
import { Story } from 'foldkit/test'

import { openPage, serve } from '@hyper-effect/core/testing'
import { Changes, Contributions, type ExtensionStatus, Extensions, type Run, type SettingsChange, UndoRefused } from '@hyper-effect/jellyware'

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

const standup: ExtensionStatus = { id: 'standup', name: 'Stand-up', version: '1', state: 'active', running: 1, error: null, settings: [] }

const related: ExtensionStatus = {
  id: 'related',
  name: 'Related issues',
  version: '2',
  state: 'active',
  running: 1,
  error: null,
  settings: [
    { key: 'max', spec: { type: 'number', label: 'Issues shown', default: 5, min: 1, max: 20 }, value: 5 },
    { key: 'urgentAction', spec: { type: 'boolean', label: 'Offer Mark urgent', default: true }, value: true },
  ],
}

const change = (id: string, state: SettingsChange['state']): SettingsChange => ({
  id,
  extension: 'related',
  author: 'Ada',
  at: Date.UTC(2026, 10, 24, 9),
  before: { max: 5 },
  after: { max: 8 },
  state,
  error: null,
})

const model = (runs: ReadonlyArray<Run> = [], settingsChanges: ReadonlyArray<SettingsChange> = []): Workshop.Model =>
  Workshop.init({ shell: { me: ada, counts: { my: 0, ENG: 0, DES: 0 }, nav: [] }, runs, extensions: [standup, related], settingsChanges }).model

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

describe('workshop: settings (Story)', () => {
  it('edits an extension’s settings as text and sends them to configure', () => {
    Story.story(
      Workshop.update,
      Story.given(model()),
      // An extension without settings has no form.
      Story.message(Workshop.Message.ClickedEditSettings({ extension: 'standup' })),
      Story.model(next => assert.isNull(next.editing)),
      Story.message(Workshop.Message.ClickedEditSettings({ extension: 'related' })),
      Story.model(next => assert.deepStrictEqual(next.editing, { extension: 'related', values: { max: '5', urgentAction: 'true' } })),
      Story.message(Workshop.Message.ChangedSetting({ key: 'max', value: '8' })),
      // Keys that are not settings are ignored.
      Story.message(Workshop.Message.ChangedSetting({ key: 'other', value: 'x' })),
      Story.message(Workshop.Message.ClickedToggleSetting({ key: 'urgentAction' })),
      Story.message(Workshop.Message.SubmittedSettings()),
      Command.expectExact(
        Workshop.Configure({ extension: 'related', values: { max: '8', urgentAction: 'false' }, author: ada.name }),
      ),
      Story.model(next => assert.isNull(next.editing)),
      Command.resolve(Workshop.Configure, Workshop.Message.CompletedSettings({ message: 'Saved.' })),
      Story.model(next => assert.strictEqual(next.notice, 'Saved.')),
    )
  })

  it('undoes only applied settings changes', () => {
    Story.story(
      Workshop.update,
      Story.given(model([], [change('one', 'reverted'), change('two', 'applied')])),
      Story.message(Workshop.Message.ClickedUndoSettings({ changeId: 'one' })),
      Story.message(Workshop.Message.ClickedUndoSettings({ changeId: 'two' })),
      Command.expectExact(Workshop.UndoSettings({ changeId: 'two' })),
      Command.resolve(Workshop.UndoSettings, Workshop.Message.CompletedSettings({ message: 'Undone.' })),
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
      Extensions.of({
        changes: Stream.make([standup, related]),
        current: Effect.succeed([standup, related]),
        reload: () => Effect.void,
        configure: () => Effect.fail('not in this test'),
        undoSettings: () => Effect.void,
        settingsChanges: Stream.make([change('two', 'applied')]),
        currentSettingsChanges: Effect.succeed([change('two', 'applied')]),
      }),
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
      assert.include(page.html, 'id="settings-related"')
      assert.notInclude(page.html, 'id="settings-standup"')
      assert.include(page.html, 'id="undo-settings-two"')
      assert.include(page.html, 'max 5 → 8')
    } finally {
      await server.dispose()
    }
  })
})
