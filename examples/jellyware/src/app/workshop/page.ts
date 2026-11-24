import { Effect, Match as M, Schema as S, Stream } from 'effect'
import { Command, Subscription, type Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import { type Program, memoizeLast, region } from '@hyper-effect/core'
import { Changes, type Contributions, ExtensionStatus, Extensions, Run, SettingsChange } from '@hyper-effect/jellyware'

import { renderTextarea } from '@/lib/textarea'
import { cn } from '@/lib/utils'
import { button } from '@/ui/button'

import { Shell, frame, loadShell, shellChanges } from '../extensions'
import { type Workspace } from '../store'

/* The workshop: change the app by prompting an agent, follow each run, undo
   it, see which extensions are loaded, and change their settings (with undo;
   a change an extension fails with is put back). Every signed-in member may
   start and undo runs and change settings. */

export const PATH = '/extensions'

// MODEL

/** The settings form open for one extension: the text of each field. */
const Editing = S.Struct({ extension: S.String, values: S.Record(S.String, S.String) })
type Editing = typeof Editing.Type

export const Model = S.Struct({
  shell: Shell,
  runs: S.Array(Run),
  extensions: S.Array(ExtensionStatus),
  settingsChanges: S.Array(SettingsChange),
  prompt: S.String,
  editing: S.NullOr(Editing),
  notice: S.NullOr(S.String),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ChangedPrompt: { text: S.String },
  SubmittedPrompt: {},
  ClickedUndo: { runId: S.String },
  GotShell: { shell: Shell },
  GotRuns: { runs: S.Array(Run) },
  GotExtensions: { extensions: S.Array(ExtensionStatus) },
  GotSettingsChanges: { changes: S.Array(SettingsChange) },
  ClickedEditSettings: { extension: S.String },
  ClickedCancelSettings: {},
  ChangedSetting: { key: S.String, value: S.String },
  ClickedToggleSetting: { key: S.String },
  SubmittedSettings: {},
  ClickedUndoSettings: { changeId: S.String },
  CompletedSettings: { message: S.String },
  SucceededStart: {},
  SucceededUndo: {},
  FailedUndo: { message: S.String },
})
export type Message = typeof Message.Type

export const ClientMessage = S.Union([
  Message.SubmittedPrompt,
  Message.ClickedUndo,
  Message.ClickedEditSettings,
  Message.ClickedCancelSettings,
  Message.ClickedToggleSetting,
  Message.SubmittedSettings,
  Message.ClickedUndoSettings,
])
export type ClientMessage = typeof ClientMessage.Type

// COMMAND

export const StartRun = Command.define('Workshop.StartRun', {
  args: { prompt: S.String, author: S.String },
  messages: [Message.SucceededStart],
  execute: ({ prompt, author }) =>
    Changes.use(changes => changes.start(prompt, author)).pipe(Effect.as(Message.SucceededStart())),
})

export const UndoRun = Command.define('Workshop.UndoRun', {
  args: { runId: S.String },
  messages: [Message.SucceededUndo, Message.FailedUndo],
  execute: ({ runId }) =>
    Changes.use(changes => changes.undo(runId)).pipe(
      Effect.as(Message.SucceededUndo()),
      Effect.catchTag('UndoRefused', error => Effect.succeed(Message.FailedUndo({ message: error.message }))),
    ),
})

export const Configure = Command.define('Workshop.Configure', {
  args: { extension: S.String, values: S.Record(S.String, S.String), author: S.String },
  messages: [Message.CompletedSettings],
  execute: ({ extension, values, author }) =>
    Extensions.use(extensions => extensions.configure(extension, values, author)).pipe(
      Effect.map(change =>
        change.state === 'applied'
          ? 'Saved. The extension runs with the new settings.'
          : `The extension did not run with these settings, so they were put back: ${change.error ?? ''}`,
      ),
      Effect.catch(message => Effect.succeed(message)),
      Effect.map(message => Message.CompletedSettings({ message })),
    ),
})

export const UndoSettings = Command.define('Workshop.UndoSettings', {
  args: { changeId: S.String },
  messages: [Message.CompletedSettings],
  execute: ({ changeId }) =>
    Extensions.use(extensions => extensions.undoSettings(changeId)).pipe(
      Effect.as('Undone. The extension runs with the earlier settings.'),
      Effect.catch(message => Effect.succeed(message)),
      Effect.map(message => Message.CompletedSettings({ message })),
    ),
})

// INIT

type Flags = Readonly<{
  shell: Shell
  runs: ReadonlyArray<Run>
  extensions: ReadonlyArray<ExtensionStatus>
  settingsChanges: ReadonlyArray<SettingsChange>
}>

export const init = (flags: Flags): Update.Return<Model, Message> => ({
  model: {
    shell: flags.shell,
    runs: flags.runs,
    extensions: flags.extensions,
    settingsChanges: flags.settingsChanges,
    prompt: '',
    editing: null,
    notice: null,
  },
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Changes | Extensions>

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ChangedPrompt: ({ text }) => ({ model: { ...model, prompt: text } }),
      SubmittedPrompt: () => {
        const prompt = model.prompt.trim()
        if (prompt === '') return { model: { ...model, notice: 'Describe the change first.' } }
        return {
          model: { ...model, prompt: '', notice: null },
          commands: [StartRun({ prompt, author: model.shell.me.name })],
        }
      },
      // Posted by a browser: only a run that exists and is installed.
      ClickedUndo: ({ runId }) =>
        model.runs.some(run => run.id === runId && run.state === 'installed')
          ? { model: { ...model, notice: null }, commands: [UndoRun({ runId })] }
          : { model },
      GotShell: ({ shell }) => ({ model: { ...model, shell } }),
      GotRuns: ({ runs }) => ({ model: { ...model, runs } }),
      GotExtensions: ({ extensions }) => ({ model: { ...model, extensions } }),
      GotSettingsChanges: ({ changes }) => ({ model: { ...model, settingsChanges: changes } }),
      // Posted by a browser: only an extension with settings.
      ClickedEditSettings: ({ extension }) => {
        const found = model.extensions.find(other => other.id === extension)
        if (found === undefined || found.settings.length === 0) return { model }
        const values = Object.fromEntries(found.settings.map(field => [field.key, String(field.value)]))
        return { model: { ...model, editing: { extension, values }, notice: null } }
      },
      ClickedCancelSettings: () => ({ model: { ...model, editing: null } }),
      ChangedSetting: ({ key, value }) =>
        model.editing === null || !(key in model.editing.values)
          ? { model }
          : { model: { ...model, editing: { ...model.editing, values: { ...model.editing.values, [key]: value } } } },
      ClickedToggleSetting: ({ key }) =>
        model.editing === null || !(key in model.editing.values)
          ? { model }
          : {
              model: {
                ...model,
                editing: {
                  ...model.editing,
                  values: { ...model.editing.values, [key]: model.editing.values[key] === 'true' ? 'false' : 'true' },
                },
              },
            },
      // The values are checked against the extension's declaration by
      // `configure`; what a browser sends here is only text.
      SubmittedSettings: () =>
        model.editing === null
          ? { model }
          : {
              model: { ...model, editing: null, notice: 'Loading the extension with the new settings…' },
              commands: [Configure({ extension: model.editing.extension, values: model.editing.values, author: model.shell.me.name })],
            },
      ClickedUndoSettings: ({ changeId }) =>
        model.settingsChanges.some(change => change.id === changeId && change.state === 'applied')
          ? { model: { ...model, notice: null }, commands: [UndoSettings({ changeId })] }
          : { model },
      CompletedSettings: ({ message }) => ({ model: { ...model, notice: message } }),
      SucceededStart: () => ({ model }),
      SucceededUndo: () => ({ model }),
      FailedUndo: ({ message }) => ({ model: { ...model, notice: message } }),
    }),
  )

// SUBSCRIPTION

// One Message per change for every open page.
const gotRuns = memoizeLast((runs: ReadonlyArray<Run>) => Message.GotRuns({ runs }))
const gotExtensions = memoizeLast((extensions: ReadonlyArray<ExtensionStatus>) => Message.GotExtensions({ extensions }))
const gotSettingsChanges = memoizeLast((changes: ReadonlyArray<SettingsChange>) => Message.GotSettingsChanges({ changes }))

export const subscriptions = Subscription.make<Model, Message, Workspace | Contributions | Changes | Extensions>()(entry => ({
  shell: entry(
    { memberId: S.String },
    {
      modelToDependencies: model => ({ memberId: model.shell.me.id }),
      dependenciesToStream: ({ memberId }) => shellChanges(memberId).pipe(Stream.map(shell => Message.GotShell({ shell }))),
    },
  ),
  runs: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () => Stream.unwrap(Changes.use(changes => Effect.succeed(changes.changes.pipe(Stream.map(gotRuns))))),
    },
  ),
  extensions: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Stream.unwrap(Extensions.use(extensions => Effect.succeed(extensions.changes.pipe(Stream.map(gotExtensions))))),
    },
  ),
  settingsChanges: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Stream.unwrap(Extensions.use(extensions => Effect.succeed(extensions.settingsChanges.pipe(Stream.map(gotSettingsChanges))))),
    },
  ),
}))

// VIEW

const STATE_LABEL: Readonly<Record<Run['state'], string>> = {
  queued: 'Queued',
  working: 'Agent working',
  checking: 'Checking',
  installing: 'Installing',
  installed: 'Live',
  unchanged: 'No change',
  failed: 'Failed',
  undone: 'Undone',
}

const STATE_CLASS: Readonly<Record<Run['state'], string>> = {
  queued: 'bg-muted text-muted-foreground',
  working: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  checking: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  installing: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  installed: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  unchanged: 'bg-muted text-muted-foreground',
  failed: 'bg-destructive/10 text-destructive',
  undone: 'bg-muted text-muted-foreground',
}

const badge = (h: HtmlBuilder<Message>, text: string, className: string): Html =>
  h.span([h.Class(cn('rounded px-1.5 py-0.5 text-[11px] font-medium', className))], [text])

const time = (millis: number) => new Date(millis).toISOString().slice(0, 16).replace('T', ' ')

const promptForm = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.form(
    [h.Id('workshop-form'), h.OnSubmit(Message.SubmittedPrompt()), h.Class('rounded-lg border bg-card focus-within:border-ring')],
    [
      renderTextarea(
        {
          id: 'workshop-prompt',
          value: model.prompt,
          placeholder: 'Describe a change: a new page, a sidebar entry, a different layout of an extension…',
          rows: 3,
          isInvalid: model.notice !== null,
          onInput: text => Message.ChangedPrompt({ text }),
        },
        {
          field: [],
          label: [],
          textarea: [
            h.AriaLabel('Change'),
            h.Class('field-sizing-content block min-h-20 w-full resize-none bg-transparent px-3.5 pt-3 text-[13.5px] outline-none placeholder:text-muted-foreground'),
          ],
          description: [],
        },
        h,
      ),
      h.div(
        [h.Class('flex items-center gap-3 px-3 pt-1 pb-2.5')],
        [
          h.p([h.Id('workshop-notice'), h.Class('flex-1 text-[12px] text-destructive'), h.AriaLive('polite')], [model.notice ?? '']),
          button({ id: 'workshop-submit', children: ['Change the app'], type: 'submit', size: 'sm', class: 'h-7 text-[12px]' }, h),
        ],
      ),
    ],
  )

const runView = (run: Run, h: HtmlBuilder<Message>): Html =>
  h.article(
    [h.Id(`run-${run.id}`), h.Class('rounded-lg border bg-card p-3'), h.DataAttribute('state', run.state)],
    [
      h.div(
        [h.Class('flex items-start gap-2')],
        [
          h.p([h.Class('min-w-0 flex-1 text-[13px] font-medium whitespace-pre-wrap')], [run.prompt]),
          badge(h, STATE_LABEL[run.state], STATE_CLASS[run.state]),
        ],
      ),
      h.p(
        [h.Class('mt-1 text-[11px] text-muted-foreground')],
        [`${run.author} · ${time(run.startedAt)} UTC${run.attempts > 1 ? ` · ${run.attempts} attempts` : ''}`],
      ),
      ...(run.changes.length === 0
        ? []
        : [
            h.ul(
              [h.Class('mt-2 flex flex-wrap gap-1.5')],
              run.changes.map(change => h.li([h.Class('rounded border px-1.5 py-0.5 text-[11px]')], [`${change.id} ${change.action}`])),
            ),
          ]),
      ...(run.summary === null ? [] : [h.p([h.Class('mt-2 text-[12.5px] whitespace-pre-wrap')], [run.summary])]),
      ...(run.error === null
        ? []
        : [h.pre([h.Class('mt-2 max-h-48 overflow-auto rounded bg-destructive/5 p-2 text-[11px] whitespace-pre-wrap text-destructive')], [run.error])]),
      ...(run.state === 'installed'
        ? [
            h.div(
              [h.Class('mt-2 flex justify-end')],
              [
                button(
                  {
                    id: `undo-${run.id}`,
                    children: ['Undo'],
                    variant: 'outline',
                    size: 'sm',
                    class: 'h-7 text-[12px]',
                    onClick: Message.ClickedUndo({ runId: run.id }),
                  },
                  h,
                ),
              ],
            ),
          ]
        : []),
    ],
  )

const describeValues = (values: Readonly<Record<string, string | number | boolean>>) =>
  Object.entries(values)
    .map(([key, value]) => `${key} ${String(value)}`)
    .join(', ')

/** What a settings change changed, as "max 5 → 8". */
const describeChange = (change: SettingsChange) =>
  Object.keys(change.after)
    .filter(key => change.before[key] !== change.after[key])
    .map(key => `${key} ${String(change.before[key])} → ${String(change.after[key])}`)
    .join(', ') || describeValues(change.after)

const settingsForm = (extension: ExtensionStatus, editing: Editing, h: HtmlBuilder<Message>): Html =>
  h.form(
    [h.Id(`settings-form-${extension.id}`), h.OnSubmit(Message.SubmittedSettings()), h.Class('mt-2 flex flex-col gap-2 rounded-md border bg-background p-2.5')],
    [
      ...extension.settings.map(field => {
        const id = `setting-${extension.id}-${field.key}`
        const text = editing.values[field.key] ?? ''
        const input =
          field.spec.type === 'boolean'
            ? h.input([
                h.Id(id),
                h.Type('checkbox'),
                h.Checked(text === 'true'),
                h.OnClick(Message.ClickedToggleSetting({ key: field.key })),
              ])
            : field.spec.type === 'select'
              ? h.select(
                  [h.Id(id), h.Class('h-7 rounded-md border bg-background px-2 text-[12px]'), h.OnChange(value => Message.ChangedSetting({ key: field.key, value }))],
                  field.spec.options.map(option => h.option([h.Value(option), h.Selected(option === text)], [option])),
                )
              : h.input([
                  h.Id(id),
                  h.Type(field.spec.type === 'number' ? 'number' : 'text'),
                  h.Value(text),
                  ...(field.spec.type === 'number' && field.spec.min !== undefined ? [h.Min(String(field.spec.min))] : []),
                  ...(field.spec.type === 'number' && field.spec.max !== undefined ? [h.Max(String(field.spec.max))] : []),
                  h.Class('h-7 w-full rounded-md border bg-background px-2 text-[12px]'),
                  h.OnInput(value => Message.ChangedSetting({ key: field.key, value })),
                ])
        return h.label(
          [h.For(id), h.Class(field.spec.type === 'boolean' ? 'flex items-center gap-2 text-[12px]' : 'flex flex-col gap-1 text-[12px]')],
          field.spec.type === 'boolean'
            ? [input, field.spec.label]
            : [
                h.span([h.Class('font-medium')], [field.spec.label]),
                input,
                ...(field.spec.description === undefined ? [] : [h.span([h.Class('text-[11px] text-muted-foreground')], [field.spec.description])]),
              ],
        )
      }),
      h.div(
        [h.Class('flex justify-end gap-1.5')],
        [
          button({ id: `settings-cancel-${extension.id}`, children: ['Cancel'], variant: 'ghost', size: 'sm', class: 'h-7 text-[12px]', onClick: Message.ClickedCancelSettings() }, h),
          button({ id: `settings-save-${extension.id}`, children: ['Save'], type: 'submit', size: 'sm', class: 'h-7 text-[12px]' }, h),
        ],
      ),
    ],
  )

const settingsHistory = (changes: ReadonlyArray<SettingsChange>, extensions: ReadonlyArray<ExtensionStatus>, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Id('workshop-settings-history'), h.Class('mt-6')],
    [
      h.h2([h.Class('mb-1 text-[12px] font-medium text-muted-foreground')], ['Settings changes']),
      changes.length === 0
        ? h.p([h.Class('text-[12px] text-muted-foreground')], ['None yet.'])
        : h.ul(
            [h.Class('divide-y')],
            changes.slice(0, 20).map(change =>
              h.li(
                [h.Id(`settings-change-${change.id}`), h.Class('py-2 text-[12px]'), h.DataAttribute('state', change.state)],
                [
                  h.div(
                    [h.Class('flex items-center gap-2')],
                    [
                      h.span([h.Class('min-w-0 flex-1')], [
                        `${extensions.find(extension => extension.id === change.extension)?.name ?? change.extension}: ${describeChange(change)}`,
                      ]),
                      badge(
                        h,
                        change.state === 'applied' ? 'Applied' : change.state === 'reverted' ? 'Put back' : 'Undone',
                        change.state === 'applied' ? STATE_CLASS.installed : change.state === 'reverted' ? STATE_CLASS.failed : STATE_CLASS.undone,
                      ),
                    ],
                  ),
                  h.p([h.Class('mt-0.5 text-[11px] text-muted-foreground')], [`${change.author} · ${time(change.at)} UTC`]),
                  ...(change.error === null
                    ? []
                    : [h.pre([h.Class('mt-1 max-h-24 overflow-auto text-[11px] whitespace-pre-wrap text-destructive')], [change.error])]),
                  ...(change.state === 'applied'
                    ? [
                        h.div(
                          [h.Class('mt-1 flex justify-end')],
                          [
                            button(
                              {
                                id: `undo-settings-${change.id}`,
                                children: ['Undo'],
                                variant: 'outline',
                                size: 'sm',
                                class: 'h-6 text-[11px]',
                                onClick: Message.ClickedUndoSettings({ changeId: change.id }),
                              },
                              h,
                            ),
                          ],
                        ),
                      ]
                    : []),
                ],
              ),
            ),
          ),
    ],
  )

const extensionRow = (extension: ExtensionStatus, editing: Editing | null, h: HtmlBuilder<Message>): Html =>
  h.li(
    [h.Id(`extension-${extension.id}`), h.Class('py-2'), h.DataAttribute('state', extension.state)],
    [
      h.div(
        [h.Class('flex items-center gap-2 text-[13px]')],
        [
          h.span([h.Class('font-medium')], [extension.name]),
          h.span([h.Class('text-muted-foreground')], [`${extension.id} · version ${extension.version}`]),
          h.span([h.Class('flex-1')], []),
          badge(
            h,
            extension.state === 'active' ? 'Running' : extension.state === 'pending' ? 'Waiting' : extension.state === 'loading' ? 'Loading' : 'Failed',
            extension.state === 'active' ? STATE_CLASS.installed : extension.state === 'failed' ? STATE_CLASS.failed : STATE_CLASS.queued,
          ),
        ],
      ),
      ...(extension.error === null
        ? []
        : [h.pre([h.Class('mt-1 max-h-32 overflow-auto text-[11px] whitespace-pre-wrap text-destructive')], [extension.error])]),
      ...(extension.settings.length === 0
        ? []
        : editing !== null && editing.extension === extension.id
          ? [settingsForm(extension, editing, h)]
          : [
              h.div(
                [h.Class('mt-1 flex items-center gap-2')],
                [
                  h.span(
                    [h.Class('min-w-0 flex-1 truncate text-[11px] text-muted-foreground')],
                    [describeValues(Object.fromEntries(extension.settings.map(field => [field.key, field.value])))],
                  ),
                  button(
                    {
                      id: `settings-${extension.id}`,
                      children: ['Settings'],
                      variant: 'outline',
                      size: 'sm',
                      class: 'h-6 text-[11px]',
                      onClick: Message.ClickedEditSettings({ extension: extension.id }),
                    },
                    h,
                  ),
                ],
              ),
            ]),
    ],
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: 'Extensions · Linear',
  body: frame(
    model.shell,
    PATH,
    [
      h.header([h.Class('flex h-11 items-center border-b px-4')], [h.h1([h.Class('text-[13px] font-semibold')], ['Extensions'])]),
      h.div(
        [h.Class('grid min-h-0 flex-1 gap-6 overflow-y-auto p-4 lg:grid-cols-[minmax(0,1fr)_20rem]')],
        [
          h.section(
            [h.Class('flex min-w-0 flex-col gap-3')],
            [
              region(h, { id: 'workshop-form', deps: [model.prompt, model.notice], render: () => promptForm(model, h) }),
              region(h, {
                id: 'workshop-runs',
                deps: [model.runs],
                render: () =>
                  h.div(
                    [h.Id('workshop-runs'), h.Class('flex flex-col gap-3')],
                    model.runs.length === 0
                      ? [h.p([h.Class('text-[13px] text-muted-foreground')], ['No changes yet.'])]
                      : model.runs.map(run => runView(run, h)),
                  ),
              }),
            ],
          ),
          region(h, {
            id: 'workshop-extensions',
            deps: [model.extensions, model.editing, model.settingsChanges],
            render: () =>
              h.section(
                [h.Id('workshop-extensions')],
                [
                  h.h2([h.Class('mb-1 text-[12px] font-medium text-muted-foreground')], ['Loaded extensions']),
                  h.ul([h.Class('divide-y')], model.extensions.map(extension => extensionRow(extension, model.editing, h))),
                  settingsHistory(model.settingsChanges, model.extensions, h),
                ],
              ),
          }),
        ],
      ),
    ],
    h,
  ),
})

export const program: Program<Model, Message, ClientMessage, Flags, Workspace | Contributions | Changes | Extensions> = {
  name: 'workshop',
  Model,
  ClientMessage,
  flags: request =>
    Effect.gen(function* () {
      const shell = yield* loadShell(request)
      const runs = yield* Changes.use(changes => changes.current)
      const extensions = yield* Extensions.use(extensions => extensions.current)
      const settingsChanges = yield* Extensions.use(extensions => extensions.currentSettingsChanges)
      return { shell, runs, extensions, settingsChanges }
    }),
  init,
  update,
  view,
  subscriptions,
  snapshotDeps: model => [model.prompt, model.editing, model.notice],
}
