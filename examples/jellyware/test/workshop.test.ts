import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer, Stream } from 'effect'
import { Story } from 'foldkit/test'

import { PageHost } from '@hyper-effect/core'
import { openPage, openStream, readUntil, serve } from '@hyper-effect/core/testing'
import {
  type Activity,
  Changes,
  Contributions,
  CurrentExtension,
  type MemberSettings,
  type ExtensionStatus,
  Extensions,
  type FileDiff,
  ReviewRefused,
  type Run,
  type SettingsChange,
  UndoRefused,
} from '@hyper-effect/jellyware'

import { USER_COOKIE_NAME, cookieValue } from '@/app/auth'
import { SEED_MEMBERS } from '@/app/seed'
import * as Store from '@/app/store'
import { CUSTOMIZATIONS } from '@/app/extensions'
import * as Workshop from '@/app/workshop/page'

/* The workshop page: prompts start runs (conversations in Chat, with what
   the agent does as it works), administrators approve or reject them after
   reading the diff, undo only for installed runs and turn extensions off
   and on, members only look; each section renders at a path of its own. */

const ada = SEED_MEMBERS[0]!
const grace = SEED_MEMBERS[1]!

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
  reviewer: null,
  thread: null,
})

/** A follow-up of `thread`. */
const followUp = (id: string, state: Run['state'], thread: string): Run => ({ ...run(id, state), thread, startedAt: run(id, state).startedAt + 60_000 })

const standup: ExtensionStatus = {
  id: 'standup',
  name: 'Stand-up',
  version: '1',
  description: null,
  isolated: false,
  data: null,
  state: 'active',
  running: 1,
  error: null,
  settings: [],
}

const related: ExtensionStatus = {
  id: 'related',
  name: 'Related issues',
  version: '2',
  description: null,
  isolated: false,
  data: null,
  state: 'active',
  running: 1,
  error: null,
  settings: [
    { key: 'max', spec: { type: 'number', label: 'Issues shown', default: 5, min: 1, max: 20, scope: 'member' }, value: 5, isSet: true },
    { key: 'urgentAction', spec: { type: 'boolean', label: 'Offer Mark urgent', default: true }, value: true, isSet: true },
    { key: 'token', spec: { type: 'secret', label: 'Token' }, value: '', isSet: true },
  ],
}

const relatedMine: MemberSettings = {
  extension: 'related',
  name: 'Related issues',
  fields: [{ key: 'max', spec: { type: 'number', label: 'Issues shown', default: 5, min: 1, max: 20, scope: 'member' }, value: 3, isSet: true }],
  own: ['max'],
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

const model = (
  runs: ReadonlyArray<Run> = [],
  settingsChanges: ReadonlyArray<SettingsChange> = [],
  me = ada,
  section: Workshop.Section = 'chat',
  thread: string | null = null,
): Workshop.Model =>
  Workshop.init({
    shell: { me, counts: { my: 0, ENG: 0, DES: 0 }, nav: [] },
    section,
    thread,
    runs,
    extensions: [standup, related],
    settingsChanges,
    members: SEED_MEMBERS,
    inventory: { nav: [], slots: [], badges: [], commands: [] },
    pages: [],
    mySettings: [relatedMine],
  }).model

const fileDiff: FileDiff = {
  extension: 'standup',
  path: 'extension.ts',
  action: 'changed',
  added: 1,
  removed: 1,
  lines: [
    { kind: 'gap', text: '4 unchanged lines' },
    { kind: 'removed', text: "label: 'Stand-up'" },
    { kind: 'added', text: "label: 'Daily'" },
  ],
  truncated: false,
}

const { Command } = Story

/** What the agent did in run three. */
const activity: ReadonlyArray<Activity> = [
  { _tag: 'Step', id: 'agent-1', at: 1, until: 9000, text: 'The agent works on the change', state: 'done', detail: null },
  { _tag: 'Tool', id: 'tool-1-a', at: 2, until: 30, name: 'read', target: 'standup/page.ts', state: 'done', detail: null },
  { _tag: 'Said', at: 40, text: 'I renamed the entry.\nChanged: standup' },
  { _tag: 'Step', id: 'check-1-1', at: 50, until: 4000, text: 'Typecheck', state: 'done', detail: null },
]

describe('workshop: update (Story)', () => {
  it('starts a run with the prompt and clears the field', () => {
    Story.story(
      Workshop.update,
      Story.given(model()),
      Story.message(Workshop.Message.SubmittedPrompt()),
      Story.model(next => assert.strictEqual(next.notice, 'Describe the change first.')),
      Story.message(Workshop.Message.ChangedPrompt({ text: '  Add a stand-up page  ' })),
      Story.message(Workshop.Message.SubmittedPrompt()),
      Command.expectExact(Workshop.StartRun({ prompt: 'Add a stand-up page', author: ada.name, thread: null })),
      Story.model(next => {
        assert.strictEqual(next.prompt, '')
        assert.isNull(next.notice)
      }),
      // The new conversation opens, and the address bar follows.
      Command.resolve(Workshop.StartRun, Workshop.Message.SucceededStart({ runId: 'new', thread: null })),
      Story.model(next => assert.strictEqual(next.thread, 'new')),
      Command.expectExact(Workshop.ReplaceUrl({ url: '/extensions/chat/new' })),
      Command.resolve(Workshop.ReplaceUrl, Workshop.Message.CompletedBrowserAction()),
    )
  })

  it('follows up the open conversation, once the agent is done with it', () => {
    Story.story(
      Workshop.update,
      Story.given(model([followUp('two', 'working', 'one'), run('one', 'installed')], [], ada, 'chat', 'one')),
      Story.message(Workshop.Message.ChangedPrompt({ text: 'Make it blue' })),
      Story.message(Workshop.Message.SubmittedPrompt()),
      Command.expectNone(),
      Story.model(next => assert.include(next.notice ?? '', 'still working')),
      Story.message(Workshop.Message.GotRuns({ runs: [followUp('two', 'review', 'one'), run('one', 'installed')] })),
      Story.message(Workshop.Message.SubmittedPrompt()),
      Command.expectExact(Workshop.StartRun({ prompt: 'Make it blue', author: ada.name, thread: 'one' })),
      // A follow-up stays in its conversation.
      Command.resolve(Workshop.StartRun, Workshop.Message.SucceededStart({ runId: 'three', thread: 'one' })),
      Story.model(next => assert.strictEqual(next.thread, 'one')),
      Command.expectNone(),
    )
  })

  it('opens sections and conversations from the URL, and keeps only the open conversation’s activity', () => {
    const said: ReadonlyArray<Activity> = [{ _tag: 'Said', at: 1, text: 'Done.' }]
    Story.story(
      Workshop.update,
      Story.given(model([followUp('two', 'review', 'one'), run('one', 'installed'), run('other', 'failed')], [], ada, 'extensions')),
      // A follow-up's id opens its conversation.
      Story.message(Workshop.Message.ChangedUrl({ section: 'chat', thread: 'two' })),
      Story.model(next => {
        assert.strictEqual(next.section, 'chat')
        assert.strictEqual(next.thread, 'one')
      }),
      Story.message(Workshop.Message.GotActivity({ runId: 'two', activity: said })),
      Story.message(Workshop.Message.GotActivity({ runId: 'other', activity: said })),
      Story.model(next => assert.deepStrictEqual(Object.keys(next.activity), ['two'])),
      Story.message(Workshop.Message.ChangedUrl({ section: 'chat', thread: 'nobody' })),
      Story.model(next => {
        assert.isNull(next.thread)
        assert.deepStrictEqual(next.activity, {})
      }),
    )
    assert.deepStrictEqual(Workshop.locate(new URL('http://x/extensions')), { section: 'extensions', thread: null })
    assert.deepStrictEqual(Workshop.locate(new URL('http://x/extensions/changes')), { section: 'changes', thread: null })
    assert.deepStrictEqual(Workshop.locate(new URL('http://x/extensions/chat/abc')), { section: 'chat', thread: 'abc' })
    assert.isNull(Workshop.locate(new URL('http://x/extensions/nothing')))
    assert.isNull(Workshop.locate(new URL('http://x/extensions/people/abc')))
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

describe('workshop: roles and review (Story)', () => {
  it('lets an administrator approve or reject only runs waiting for review', () => {
    Story.story(
      Workshop.update,
      Story.given(model([run('waiting', 'review'), run('live', 'installed')])),
      Story.message(Workshop.Message.ClickedApprove({ runId: 'live' })),
      Story.message(Workshop.Message.ClickedReject({ runId: 'unknown' })),
      Story.message(Workshop.Message.ClickedApprove({ runId: 'waiting' })),
      Command.expectExact(Workshop.Approve({ runId: 'waiting', reviewer: ada.name })),
      Command.resolve(Workshop.Approve, Workshop.Message.FailedReview({ message: 'standup changed since this run started.' })),
      Story.model(next => assert.strictEqual(next.notice, 'standup changed since this run started.')),
      Story.message(Workshop.Message.ClickedReject({ runId: 'waiting' })),
      Command.expectExact(Workshop.Reject({ runId: 'waiting', reviewer: ada.name })),
      Command.resolve(Workshop.Reject, Workshop.Message.SucceededReview()),
    )
  })

  it('refuses every change a member’s browser posts', () => {
    Story.story(
      Workshop.update,
      Story.given(model([run('waiting', 'review'), run('live', 'installed')], [change('two', 'applied')], grace)),
      Story.message(Workshop.Message.ChangedPrompt({ text: 'Add a page' })),
      Story.message(Workshop.Message.SubmittedPrompt()),
      Story.message(Workshop.Message.ClickedApprove({ runId: 'waiting' })),
      Story.message(Workshop.Message.ClickedReject({ runId: 'waiting' })),
      Story.message(Workshop.Message.ClickedUndo({ runId: 'live' })),
      Story.message(Workshop.Message.ClickedEditSettings({ extension: 'related' })),
      Story.message(Workshop.Message.ClickedUndoSettings({ changeId: 'two' })),
      Story.message(Workshop.Message.ClickedSetRole({ memberId: 'grace', role: 'admin' })),
      Command.expectNone(),
      Story.model(next => assert.isNull(next.editing)),
      // Looking at a run's changes is for everyone.
      Story.message(Workshop.Message.ClickedShowChanges({ runId: 'live' })),
      Story.model(next => assert.deepStrictEqual(next.shown, ['live'])),
    )
  })

  it('gives roles to others, and closes the settings form of a member who loses the role', () => {
    Story.story(
      Workshop.update,
      Story.given(model()),
      // Not to oneself, and only to members who exist.
      Story.message(Workshop.Message.ClickedSetRole({ memberId: ada.id, role: 'member' })),
      Story.message(Workshop.Message.ClickedSetRole({ memberId: 'nobody', role: 'admin' })),
      Story.message(Workshop.Message.ClickedSetRole({ memberId: grace.id, role: 'admin' })),
      Command.expectExact(Workshop.SetRole({ memberId: grace.id, role: 'admin', actorId: ada.id })),
      Command.resolve(Workshop.SetRole, Workshop.Message.SucceededRole()),
      Story.message(Workshop.Message.ClickedEditSettings({ extension: 'related' })),
      Story.model(next => assert.isNotNull(next.editing)),
      Story.message(Workshop.Message.GotShell({ shell: { me: { ...ada, role: 'member' }, counts: { my: 0, ENG: 0, DES: 0 }, nav: [] } })),
      Story.model(next => assert.isNull(next.editing)),
    )
  })
})

describe('workshop: extensions off and on (Story)', () => {
  it('turns an extension off and on, for administrators only', () => {
    const off: ExtensionStatus = { ...standup, state: 'disabled', running: null }
    Story.story(
      Workshop.update,
      Story.given(model([], [], ada, 'extensions')),
      Story.message(Workshop.Message.ClickedToggleExtension({ extension: 'nothing' })),
      Command.expectNone(),
      Story.message(Workshop.Message.ClickedToggleExtension({ extension: 'standup' })),
      Command.expectExact(Workshop.SetEnabled({ extension: 'standup', enabled: false })),
      Command.resolve(Workshop.SetEnabled, Workshop.Message.CompletedSettings({ message: 'Turned off.' })),
      Story.message(Workshop.Message.GotExtensions({ extensions: [off, related] })),
      Story.message(Workshop.Message.ClickedToggleExtension({ extension: 'standup' })),
      Command.expectExact(Workshop.SetEnabled({ extension: 'standup', enabled: true })),
      Command.resolve(Workshop.SetEnabled, Workshop.Message.CompletedSettings({ message: 'Turned on.' })),
    )
    Story.story(
      Workshop.update,
      Story.given(model([], [], grace, 'extensions')),
      Story.message(Workshop.Message.ClickedToggleExtension({ extension: 'standup' })),
      Command.expectNone(),
    )
  })
})

describe('workshop: what you can customize (Story)', () => {
  it('fills the prompt with an example, for administrators only', () => {
    const example = CUSTOMIZATIONS.find(each => each.id === 'issues.badges')!.example
    Story.story(
      Workshop.update,
      Story.given(model()),
      Story.message(Workshop.Message.ClickedTryExample({ id: 'nothing' })),
      Story.model(next => assert.strictEqual(next.prompt, '')),
      Story.message(Workshop.Message.ClickedTryExample({ id: 'issues.badges' })),
      Story.model(next => assert.strictEqual(next.prompt, example)),
    )
    // From another section: a new conversation opens with it.
    Story.story(
      Workshop.update,
      Story.given(model([], [], ada, 'customize')),
      Story.message(Workshop.Message.ClickedTryExample({ id: 'issues.badges' })),
      Story.model(next => {
        assert.strictEqual(next.section, 'chat')
        assert.isNull(next.thread)
        assert.strictEqual(next.prompt, example)
      }),
      Command.expectExact(Workshop.PushUrl({ url: '/extensions/chat' })),
      Command.resolve(Workshop.PushUrl, Workshop.Message.CompletedBrowserAction()),
    )
    Story.story(
      Workshop.update,
      Story.given(model([], [], grace)),
      Story.message(Workshop.Message.ClickedTryExample({ id: 'issues.badges' })),
      Story.model(next => assert.strictEqual(next.prompt, '')),
    )
  })
})

describe('workshop: secrets and your own settings (Story)', () => {
  it('starts a secret empty, sends it as typed, and removes it for administrators only', () => {
    Story.story(
      Workshop.update,
      Story.given(model()),
      Story.message(Workshop.Message.ClickedEditSettings({ extension: 'related' })),
      Story.model(next => assert.deepStrictEqual(next.editing?.values, { max: '5', urgentAction: 'true', token: '' })),
      Story.message(Workshop.Message.ClickedClearSecret({ key: 'max' })),
      Story.message(Workshop.Message.ClickedClearSecret({ key: 'token' })),
      Command.expectExact(Workshop.ClearSecret({ extension: 'related', key: 'token', author: ada.name })),
      Story.model(next => assert.isNull(next.editing)),
      Command.resolve(Workshop.ClearSecret, Workshop.Message.CompletedSettings({ message: 'Removed.' })),
    )
  })

  it('lets every member change and reset their own values, and nothing else', () => {
    Story.story(
      Workshop.update,
      Story.given(model([], [], grace)),
      Story.message(Workshop.Message.ClickedEditSettings({ extension: 'related' })),
      Story.model(next => assert.isNull(next.editing)),
      Story.message(Workshop.Message.ClickedEditMine({ extension: 'related' })),
      Story.model(next => assert.deepStrictEqual(next.editing, { extension: 'related', values: { max: '3' }, mine: true })),
      Story.message(Workshop.Message.ClickedClearSecret({ key: 'token' })),
      Story.message(Workshop.Message.ChangedSetting({ key: 'max', value: '2' })),
      Story.message(Workshop.Message.SubmittedSettings()),
      Command.expectExact(Workshop.ConfigureMine({ extension: 'related', memberId: grace.id, values: { max: '2' } })),
      Command.resolve(Workshop.ConfigureMine, Workshop.Message.CompletedSettings({ message: 'Saved your settings.' })),
      Story.message(Workshop.Message.ClickedResetMine({ extension: 'related' })),
      Command.expectExact(Workshop.ResetMine({ extension: 'related', memberId: grace.id })),
      Command.resolve(Workshop.ResetMine, Workshop.Message.CompletedSettings({ message: 'Back on the defaults.' })),
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
      Story.model(next => assert.deepStrictEqual(next.editing, { extension: 'related', values: { max: '5', urgentAction: 'true', token: '' }, mine: false })),
      Story.message(Workshop.Message.ChangedSetting({ key: 'max', value: '8' })),
      // Keys that are not settings are ignored.
      Story.message(Workshop.Message.ChangedSetting({ key: 'other', value: 'x' })),
      Story.message(Workshop.Message.ClickedToggleSetting({ key: 'urgentAction' })),
      Story.message(Workshop.Message.SubmittedSettings()),
      Command.expectExact(
        Workshop.Configure({ extension: 'related', values: { max: '8', urgentAction: 'false', token: '' }, author: ada.name }),
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
  // Related's card and command, registered as the loader would: owned by it.
  const contributions = Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* Contributions
      yield* registry.slot({ slot: 'issue.sidebar', id: 'related', content: () => Stream.never })
      yield* registry.command({ id: 'related.mark-urgent', run: () => Effect.succeed('') })
    }).pipe(Effect.provideService(CurrentExtension, 'related')),
  ).pipe(Layer.provideMerge(Contributions.layer))
  const pageHost = Layer.succeed(
    PageHost,
    PageHost.of({
      mount: () => Effect.void,
      mountRoutes: () => Effect.void,
      names: Effect.succeed(['standup']),
      pages: Effect.succeed([{ name: 'standup', paths: ['/standup'], owner: 'standup' }]),
    }),
  )
  const services = Layer.mergeAll(
    Store.layer,
    contributions,
    pageHost,
    Layer.succeed(
      Changes,
      Changes.of({
        changes: Stream.make([run('one', 'installed'), run('two', 'failed'), run('three', 'review')]),
        current: Effect.succeed([run('one', 'installed'), run('two', 'failed'), run('three', 'review')]),
        start: () => Effect.succeed('four'),
        activity: runId => Stream.make(runId === 'three' ? activity : []),
        undo: () => Effect.fail(new UndoRefused({ message: 'no' })),
        approve: () => Effect.void,
        reject: () => Effect.void,
        diff: runId => (runId === 'three' ? Effect.succeed([fileDiff]) : Effect.fail(new ReviewRefused({ message: 'no' }))),
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
        clearSecrets: () => Effect.fail('not in this test'),
        memberSettings: () => Stream.make([relatedMine]),
        configureMember: () => Effect.void,
        resetMember: () => Effect.void,
        setEnabled: () => Effect.void,
      }),
    ),
  )

  const options = { path: Workshop.PATH, paths: Workshop.PATHS }
  /** Each section of the page as `name` sees it. */
  const sections = async (handler: Parameters<typeof openPage>[0], name: string) => {
    const cookie = `${USER_COOKIE_NAME}=${cookieValue(name)}`
    const html: Record<string, string> = {}
    for (const path of ['/extensions', '/extensions/chat', '/extensions/chat/three', '/extensions/changes', '/extensions/customize', '/extensions/people']) {
      const page = await openPage(handler, path, cookie)
      assert.strictEqual(page.response.status, 200, path)
      html[path] = page.html
    }
    return html
  }

  it('renders each section for an administrator', async () => {
    const server = serve(Workshop.program, options, undefined, services)
    try {
      const html = await sections(server.handler, 'Ada')
      const extensions = html['/extensions']!
      const chat = html['/extensions/chat']!
      const thread = html['/extensions/chat/three']!
      const changes = html['/extensions/changes']!
      const customize = html['/extensions/customize']!
      const people = html['/extensions/people']!
      // The second sidebar, on every section, with the conversations.
      for (const page of Object.values(html)) {
        for (const section of Workshop.SECTIONS) assert.include(page, `id="section-${section}"`)
        assert.include(page, 'id="thread-three"')
        assert.include(page, 'Manage extensions')
      }
      assert.match(extensions, /<a[^>]*aria-current="page"[^>]*id="section-extensions"|<a[^>]*id="section-extensions"[^>]*aria-current="page"/)
      // Extensions: what each adds, its settings, on and off.
      assert.include(extensions, 'id="extension-standup"')
      assert.include(extensions, 'id="toggle-standup"')
      assert.match(extensions, /id="extension-adds-related"[^>]*>.*cards on an issue · command related\.mark-urgent/)
      assert.match(extensions, /id="extension-adds-standup"[^>]*>.*page \/standup/)
      assert.include(extensions, 'id="settings-related"')
      assert.notInclude(extensions, 'id="settings-standup"')
      assert.include(extensions, 'id="undo-settings-two"')
      assert.include(extensions, 'max 5 → 8')
      assert.include(extensions, 'id="mine-edit-related"')
      assert.notInclude(extensions, 'id="workshop-prompt"')
      // Chat: a new conversation with examples; a conversation with its run.
      assert.include(chat, 'id="workshop-prompt"')
      assert.include(chat, 'id="suggest-issues-badges"')
      assert.include(thread, 'id="run-three"')
      assert.include(thread, 'id="approve-three"')
      assert.include(thread, 'id="diff-three"')
      assert.include(thread, 'Follow up')
      // Changes: every run, with review and undo.
      assert.include(changes, 'id="run-one"')
      assert.include(changes, 'id="undo-one"')
      assert.include(changes, 'id="approve-three"')
      assert.include(changes, 'id="reject-three"')
      assert.include(changes, 'id="changes-one"')
      assert.include(changes, 'id="open-chat-one"')
      assert.notInclude(changes, 'id="undo-two"')
      assert.include(changes, 'error TS2322')
      // Every way to customize, with what fills it now and an example.
      for (const each of CUSTOMIZATIONS) assert.include(customize, `>${each.title}<`)
      assert.include(customize, 'id="try-issues-badges"')
      assert.match(customize, /id="customize-issue-sidebar"[\s\S]*?Now: <\/span>Related issues/)
      assert.match(customize, /id="customize-issues-badges"[\s\S]*?Now: <\/span>nothing yet/)
      assert.include(people, 'id="role-grace"')
      assert.notInclude(people, 'id="role-ada"')
      // A path the page does not serve.
      const missing = await openPage(server.handler, '/extensions/nothing', `${USER_COOKIE_NAME}=${cookieValue('Ada')}`)
      assert.strictEqual(missing.response.status, 404)
    } finally {
      await server.dispose()
    }
  })

  it('streams what the agent does in a conversation', async () => {
    const server = serve(Workshop.program, options, undefined, services)
    try {
      const page = await openPage(server.handler, '/extensions/chat/three', `${USER_COOKIE_NAME}=${cookieValue('Ada')}`)
      const stream = await readUntil(await openStream(server.handler, page), 'Typecheck')
      assert.include(stream, 'data-tool="read"')
      assert.include(stream, 'standup/page.ts')
      assert.include(stream, 'I renamed the entry.')
      assert.notInclude(stream, 'Changed: standup')
    } finally {
      await server.dispose()
    }
  })

  it('shows a member the runs and their changes, but nothing to change', async () => {
    const server = serve(Workshop.program, options, undefined, services)
    try {
      const html = await sections(server.handler, 'Grace')
      const all = Object.values(html).join('\n')
      assert.include(html['/extensions/chat']!, 'Only administrators change the app. Ask Ada Lovelace')
      assert.notInclude(all, 'id="workshop-prompt"')
      assert.notInclude(all, 'id="new-chat"')
      assert.include(html['/extensions/changes']!, 'id="run-three"')
      assert.include(html['/extensions/changes']!, 'Waiting for an administrator')
      for (const id of ['approve-three', 'reject-three', 'undo-one', 'settings-related', 'undo-settings-two', 'role-ada', 'toggle-standup', 'suggest-issues-badges']) {
        assert.notInclude(all, `id="${id}"`)
      }
      assert.include(html['/extensions/changes']!, 'id="changes-one"')
      assert.include(html['/extensions/customize']!, 'id="customize-issues-palette"')
      assert.notInclude(all, 'id="try-issues-palette"')
      // Their own settings, with what is theirs and what is the default.
      assert.include(html['/extensions']!, 'id="mine-edit-related"')
      assert.include(html['/extensions']!, 'Issues shown: 3 (yours)')
      // A secret shows only as set.
      assert.include(html['/extensions']!, 'token set')
    } finally {
      await server.dispose()
    }
  })
})

describe('workspace roles', () => {
  it.effect('only administrators give roles, and one administrator always stays', () =>
    Effect.gen(function* () {
      const workspace = yield* Store.Workspace
      const reason = (effect: Effect.Effect<void, Store.InvalidChange>) =>
        effect.pipe(
          Effect.as('done'),
          Effect.catchTag('InvalidChange', error => Effect.succeed(error.reason)),
        )
      const newcomer = yield* workspace.memberFor('Lukas')
      assert.strictEqual(newcomer.role, 'member')
      assert.strictEqual(yield* reason(workspace.setRole('lukas', 'admin', 'grace')), 'Only administrators give roles.')
      assert.strictEqual(yield* reason(workspace.setRole('ada', 'member', 'ada')), 'The workspace needs at least one administrator.')
      assert.strictEqual(yield* reason(workspace.setRole('lukas', 'admin', 'ada')), 'done')
      assert.strictEqual(yield* reason(workspace.setRole('ada', 'member', 'lukas')), 'done')
      const roles = (yield* workspace.current).members.map(member => `${member.id}:${member.role}`)
      assert.includeMembers(roles, ['ada:member', 'lukas:admin'])
    }).pipe(Effect.provide(Store.layer)),
  )
})
