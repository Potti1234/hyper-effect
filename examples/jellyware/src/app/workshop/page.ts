import { Effect, Match as M, Schema as S, Stream } from 'effect'
import { Command, Subscription, type Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import { PageHost, type Program, memoizeLast, region } from '@hyper-effect/core'
import {
  Changes,
  Contributions,
  type DiffLine,
  ExtensionStatus,
  Extensions,
  FileDiff,
  Inventory,
  Run,
  SettingsChange,
} from '@hyper-effect/jellyware'

import { renderTextarea } from '@/lib/textarea'
import { cn } from '@/lib/utils'
import { button } from '@/ui/button'

import { Member, Role } from '../domain'
import { CUSTOMIZATIONS, type Customization, Shell, frame, isAdmin, loadShell, shellChanges } from '../extensions'
import { Workspace } from '../store'

/* The workshop: change the app by prompting an agent, read what a run would
   change and approve or reject it, follow each run, undo it, see which
   extensions are loaded and what each adds, and change their settings
   (with undo; a change an extension fails with is put back). "What you can
   customize" lists every place an extension can change (CUSTOMIZATIONS in
   src/app/extensions.ts), what is in it now, and an example prompt.

   Administrators do all of that and give others the role; members see the
   runs, their changes and the extensions. update checks the role for every
   Message a browser posts, from the member as the server knows them (the
   shell's Subscription keeps it current). */

export const PATH = '/extensions'

// MODEL

/** A page served by the page host, and the extension that mounted it. */
const HostedPage = S.Struct({ name: S.String, paths: S.Array(S.String), owner: S.NullOr(S.String) })
type HostedPage = typeof HostedPage.Type

/** The settings form open for one extension: the text of each field. */
const Editing = S.Struct({ extension: S.String, values: S.Record(S.String, S.String) })
type Editing = typeof Editing.Type

export const Model = S.Struct({
  shell: Shell,
  runs: S.Array(Run),
  extensions: S.Array(ExtensionStatus),
  settingsChanges: S.Array(SettingsChange),
  members: S.Array(Member),
  /** What extensions registered, and the pages they serve. */
  inventory: Inventory,
  pages: S.Array(HostedPage),
  /** What runs change, by run id: the runs in review and those in `shown`. */
  diffs: S.Record(S.String, S.Array(FileDiff)),
  /** Runs not in review whose changes the member opened. */
  shown: S.Array(S.String),
  prompt: S.String,
  editing: S.NullOr(Editing),
  notice: S.NullOr(S.String),
})
export type Model = typeof Model.Type

const admin = (model: Model) => isAdmin(model.shell.me)

// MESSAGE

export const Message = defineMessageUnion({
  ChangedPrompt: { text: S.String },
  SubmittedPrompt: {},
  ClickedUndo: { runId: S.String },
  ClickedApprove: { runId: S.String },
  ClickedReject: { runId: S.String },
  ClickedShowChanges: { runId: S.String },
  ClickedHideChanges: { runId: S.String },
  ClickedSetRole: { memberId: S.String, role: Role },
  ClickedTryExample: { id: S.String },
  GotInventory: { inventory: Inventory },
  GotPages: { pages: S.Array(HostedPage) },
  GotShell: { shell: Shell },
  GotMembers: { members: S.Array(Member) },
  GotDiffs: { diffs: S.Record(S.String, S.Array(FileDiff)) },
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
  SucceededReview: {},
  FailedReview: { message: S.String },
  SucceededRole: {},
  FailedRole: { message: S.String },
})
export type Message = typeof Message.Type

export const ClientMessage = S.Union([
  Message.SubmittedPrompt,
  Message.ClickedUndo,
  Message.ClickedApprove,
  Message.ClickedReject,
  Message.ClickedShowChanges,
  Message.ClickedHideChanges,
  Message.ClickedSetRole,
  Message.ClickedTryExample,
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

export const Approve = Command.define('Workshop.Approve', {
  args: { runId: S.String, reviewer: S.String },
  messages: [Message.SucceededReview, Message.FailedReview],
  execute: ({ runId, reviewer }) =>
    Changes.use(changes => changes.approve(runId, reviewer)).pipe(
      Effect.as(Message.SucceededReview()),
      Effect.catchTag('ReviewRefused', error => Effect.succeed(Message.FailedReview({ message: error.message }))),
    ),
})

export const Reject = Command.define('Workshop.Reject', {
  args: { runId: S.String, reviewer: S.String },
  messages: [Message.SucceededReview, Message.FailedReview],
  execute: ({ runId, reviewer }) =>
    Changes.use(changes => changes.reject(runId, reviewer)).pipe(
      Effect.as(Message.SucceededReview()),
      Effect.catchTag('ReviewRefused', error => Effect.succeed(Message.FailedReview({ message: error.message }))),
    ),
})

export const SetRole = Command.define('Workshop.SetRole', {
  args: { memberId: S.String, role: Role, actorId: S.String },
  messages: [Message.SucceededRole, Message.FailedRole],
  execute: ({ memberId, role, actorId }) =>
    Workspace.use(workspace => workspace.setRole(memberId, role, actorId)).pipe(
      Effect.as(Message.SucceededRole()),
      Effect.catchTag('InvalidChange', error => Effect.succeed(Message.FailedRole({ message: error.reason }))),
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
  members: ReadonlyArray<Member>
  inventory: Inventory
  pages: ReadonlyArray<HostedPage>
}>

export const init = (flags: Flags): Update.Return<Model, Message> => ({
  model: {
    shell: flags.shell,
    runs: flags.runs,
    extensions: flags.extensions,
    settingsChanges: flags.settingsChanges,
    members: flags.members,
    inventory: flags.inventory,
    pages: flags.pages,
    diffs: {},
    shown: [],
    prompt: '',
    editing: null,
    notice: null,
  },
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Changes | Extensions | Workspace>

/** Runs whose changes can be shown: those that got as far as review or
 *  install. */
const HAS_DIFF: ReadonlySet<Run['state']> = new Set(['review', 'installed', 'undone', 'rejected', 'failed'])

const runWith = (model: Model, runId: string, states: ReadonlySet<Run['state']>) =>
  model.runs.find(run => run.id === runId && states.has(run.state) && run.changes.length > 0)

const REVIEW: ReadonlySet<Run['state']> = new Set(['review'])
const INSTALLED: ReadonlySet<Run['state']> = new Set(['installed'])

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ChangedPrompt: ({ text }) => ({ model: { ...model, prompt: text } }),
      // Every Message a browser posts that changes the app checks the role.
      SubmittedPrompt: () => {
        if (!admin(model)) return { model }
        const prompt = model.prompt.trim()
        if (prompt === '') return { model: { ...model, notice: 'Describe the change first.' } }
        return {
          model: { ...model, prompt: '', notice: null },
          commands: [StartRun({ prompt, author: model.shell.me.name })],
        }
      },
      // Posted by a browser: only a run that exists and is installed.
      ClickedUndo: ({ runId }) =>
        admin(model) && runWith(model, runId, INSTALLED) !== undefined
          ? { model: { ...model, notice: null }, commands: [UndoRun({ runId })] }
          : { model },
      ClickedApprove: ({ runId }) =>
        admin(model) && runWith(model, runId, REVIEW) !== undefined
          ? { model: { ...model, notice: null }, commands: [Approve({ runId, reviewer: model.shell.me.name })] }
          : { model },
      ClickedReject: ({ runId }) =>
        admin(model) && runWith(model, runId, REVIEW) !== undefined
          ? { model: { ...model, notice: null }, commands: [Reject({ runId, reviewer: model.shell.me.name })] }
          : { model },
      ClickedShowChanges: ({ runId }) =>
        runWith(model, runId, HAS_DIFF) !== undefined && !model.shown.includes(runId)
          ? { model: { ...model, shown: [...model.shown, runId] } }
          : { model },
      ClickedHideChanges: ({ runId }) => ({ model: { ...model, shown: model.shown.filter(id => id !== runId) } }),
      ClickedSetRole: ({ memberId, role }) =>
        admin(model) && memberId !== model.shell.me.id && model.members.some(member => member.id === memberId)
          ? { model: { ...model, notice: null }, commands: [SetRole({ memberId, role, actorId: model.shell.me.id })] }
          : { model },
      // Fills the prompt with the example of one way to customize the app.
      ClickedTryExample: ({ id }) => {
        const found = CUSTOMIZATIONS.find(each => each.id === id)
        return admin(model) && found !== undefined ? { model: { ...model, prompt: found.example, notice: null } } : { model }
      },
      GotInventory: ({ inventory }) => ({ model: { ...model, inventory } }),
      GotPages: ({ pages }) => ({ model: { ...model, pages } }),
      // A member who loses the role mid-edit loses the open form.
      GotShell: ({ shell }) => ({ model: { ...model, shell, editing: isAdmin(shell.me) ? model.editing : null } }),
      GotMembers: ({ members }) => ({ model: { ...model, members } }),
      GotDiffs: ({ diffs }) => ({ model: { ...model, diffs } }),
      GotRuns: ({ runs }) => ({ model: { ...model, runs } }),
      GotExtensions: ({ extensions }) => ({ model: { ...model, extensions } }),
      GotSettingsChanges: ({ changes }) => ({ model: { ...model, settingsChanges: changes } }),
      // Posted by a browser: only an extension with settings.
      ClickedEditSettings: ({ extension }) => {
        if (!admin(model)) return { model }
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
        model.editing === null || !admin(model)
          ? { model }
          : {
              model: { ...model, editing: null, notice: 'Loading the extension with the new settings…' },
              commands: [Configure({ extension: model.editing.extension, values: model.editing.values, author: model.shell.me.name })],
            },
      ClickedUndoSettings: ({ changeId }) =>
        admin(model) && model.settingsChanges.some(change => change.id === changeId && change.state === 'applied')
          ? { model: { ...model, notice: null }, commands: [UndoSettings({ changeId })] }
          : { model },
      CompletedSettings: ({ message }) => ({ model: { ...model, notice: message } }),
      SucceededStart: () => ({ model }),
      SucceededUndo: () => ({ model }),
      FailedUndo: ({ message }) => ({ model: { ...model, notice: message } }),
      SucceededReview: () => ({ model }),
      FailedReview: ({ message }) => ({ model: { ...model, notice: message } }),
      SucceededRole: () => ({ model }),
      FailedRole: ({ message }) => ({ model: { ...model, notice: message } }),
    }),
  )

// SUBSCRIPTION

// One Message per change for every open page.
const gotRuns = memoizeLast((runs: ReadonlyArray<Run>) => Message.GotRuns({ runs }))
const gotExtensions = memoizeLast((extensions: ReadonlyArray<ExtensionStatus>) => Message.GotExtensions({ extensions }))
const gotSettingsChanges = memoizeLast((changes: ReadonlyArray<SettingsChange>) => Message.GotSettingsChanges({ changes }))
const gotMembers = memoizeLast((members: ReadonlyArray<Member>) => Message.GotMembers({ members }))
const gotInventory = memoizeLast((inventory: Inventory) => Message.GotInventory({ inventory }))

/** The runs whose diffs the page shows, sorted. */
const diffIds = (model: Model) =>
  model.runs
    .filter(run => run.state === 'review' || (model.shown.includes(run.id) && HAS_DIFF.has(run.state)))
    .map(run => run.id)
    .sort()

export const subscriptions = Subscription.make<Model, Message, Workspace | Contributions | Changes | Extensions | PageHost>()(entry => ({
  inventory: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Stream.unwrap(Contributions.use(contributions => Effect.succeed(contributions.inventoryChanges.pipe(Stream.map(gotInventory))))),
    },
  ),
  // Pages come and go with extensions: read again after each change.
  pages: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            const extensions = yield* Extensions
            const host = yield* PageHost
            return extensions.changes.pipe(
              Stream.mapEffect(() => host.pages),
              Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
              Stream.map(pages => Message.GotPages({ pages })),
            )
          }),
        ),
    },
  ),
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
  members: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Stream.unwrap(
          Workspace.use(workspace =>
            Effect.succeed(
              workspace.changes.pipe(
                Stream.map(state => state.members),
                Stream.changes,
                Stream.map(gotMembers),
              ),
            ),
          ),
        ),
    },
  ),
  // Read once per set of runs: a run's files do not change once checked.
  diffs: entry(
    { runIds: S.Array(S.String) },
    {
      modelToDependencies: model => ({ runIds: diffIds(model) }),
      dependenciesToStream: ({ runIds }) =>
        Stream.fromEffect(
          Changes.use(changes =>
            Effect.forEach(runIds, runId =>
              changes.diff(runId).pipe(
                Effect.orElseSucceed((): ReadonlyArray<FileDiff> => []),
                Effect.map(files => [runId, files] as const),
              ),
            ),
          ),
        ).pipe(Stream.map(pairs => Message.GotDiffs({ diffs: Object.fromEntries(pairs) }))),
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
  review: 'Waiting for review',
  installing: 'Installing',
  installed: 'Live',
  unchanged: 'No change',
  failed: 'Failed',
  rejected: 'Rejected',
  undone: 'Undone',
}

const STATE_CLASS: Readonly<Record<Run['state'], string>> = {
  queued: 'bg-muted text-muted-foreground',
  working: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  checking: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  review: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  installing: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  installed: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  unchanged: 'bg-muted text-muted-foreground',
  failed: 'bg-destructive/10 text-destructive',
  rejected: 'bg-muted text-muted-foreground',
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

/** In place of the prompt form for members. */
const membersNote = (model: Model, h: HtmlBuilder<Message>): Html => {
  const admins = model.members.filter(isAdmin).map(member => member.name)
  return h.div(
    [h.Id('workshop-form'), h.Class('rounded-lg border border-dashed px-3.5 py-3 text-[13px] text-muted-foreground')],
    [
      h.p([h.Id('workshop-members-note')], [
        `Only administrators change the app. Ask ${admins.join(', ') || 'an administrator'} for a change, or for the role.`,
      ]),
      h.p([h.Id('workshop-notice'), h.Class('text-[12px] text-destructive'), h.AriaLive('polite')], [model.notice ?? '']),
    ],
  )
}

const LINE_CLASS: Readonly<Record<DiffLine['kind'], string>> = {
  same: 'px-2',
  added: 'bg-emerald-500/10 px-2 text-emerald-800 dark:text-emerald-300',
  removed: 'bg-destructive/10 px-2 text-destructive',
  gap: 'bg-muted/60 px-2 text-muted-foreground italic',
}

const LINE_PREFIX = { same: '  ', added: '+ ', removed: '- ', gap: '⋯ ' } as const

const diffView = (runId: string, files: ReadonlyArray<FileDiff> | undefined, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Id(`diff-${runId}`), h.Class('mt-2 flex flex-col gap-2')],
    files === undefined
      ? [h.p([h.Class('text-[12px] text-muted-foreground')], ['Reading the changes…'])]
      : files.length === 0
        ? [h.p([h.Class('text-[12px] text-muted-foreground')], ['No file changes to show.'])]
        : files.map(file =>
            h.div(
              [h.Class('overflow-hidden rounded-md border'), h.DataAttribute('file', `${file.extension}/${file.path}`)],
              [
                h.div(
                  [h.Class('flex items-center gap-2 border-b bg-muted/40 px-2 py-1 text-[11px]')],
                  [
                    h.span([h.Class('min-w-0 truncate font-mono')], [`${file.extension}/${file.path}`]),
                    h.span([h.Class('text-muted-foreground')], [file.action]),
                    h.span([h.Class('flex-1')], []),
                    h.span([h.Class('tabular-nums text-emerald-700 dark:text-emerald-400')], [`+${file.added}`]),
                    h.span([h.Class('tabular-nums text-destructive')], [`−${file.removed}`]),
                  ],
                ),
                file.lines === null
                  ? h.p([h.Class('px-2 py-1 text-[11px] text-muted-foreground')], ['Not a text file.'])
                  : h.pre(
                      [h.Class('max-h-96 overflow-auto py-1 font-mono text-[11px] leading-[1.5]')],
                      [
                        ...file.lines.map(line => h.div([h.Class(LINE_CLASS[line.kind])], [LINE_PREFIX[line.kind] + line.text])),
                        ...(file.truncated ? [h.div([h.Class(LINE_CLASS.gap)], ['⋯ the rest of this file is left out'])] : []),
                      ],
                    ),
              ],
            ),
          ),
  )

const smallButton = (id: string, label: string, message: Message, variant: 'default' | 'outline' | 'ghost', h: HtmlBuilder<Message>): Html =>
  button({ id, children: [label], variant, size: 'sm', class: 'h-7 text-[12px]', onClick: message }, h)

const runView = (run: Run, model: Model, h: HtmlBuilder<Message>): Html => {
  // A decided run's changes open on request; a run in review shows them.
  const canShow = run.state !== 'review' && HAS_DIFF.has(run.state) && run.changes.length > 0
  const canUndo = run.state === 'installed' && admin(model)
  return h.article(
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
        [
          `${run.author} · ${time(run.startedAt)} UTC${run.attempts > 1 ? ` · ${run.attempts} attempts` : ''}${
            run.reviewer === null ? '' : ` · ${run.state === 'rejected' ? 'rejected' : 'approved'} by ${run.reviewer}`
          }`,
        ],
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
      ...(run.state === 'review'
        ? [
            diffView(run.id, model.diffs[run.id], h),
            admin(model)
              ? h.div(
                  [h.Class('mt-2 flex items-center justify-end gap-1.5')],
                  [
                    h.span([h.Class('flex-1 text-[11px] text-muted-foreground')], ['Read the changes, then decide. Nothing is live yet.']),
                    smallButton(`reject-${run.id}`, 'Reject', Message.ClickedReject({ runId: run.id }), 'ghost', h),
                    smallButton(`approve-${run.id}`, 'Approve and install', Message.ClickedApprove({ runId: run.id }), 'default', h),
                  ],
                )
              : h.p([h.Class('mt-2 text-[11px] text-muted-foreground')], ['Waiting for an administrator to read and approve it.']),
          ]
        : []),
      ...(canShow && model.shown.includes(run.id) ? [diffView(run.id, model.diffs[run.id], h)] : []),
      ...(canShow || canUndo
        ? [
            h.div(
              [h.Class('mt-2 flex justify-end gap-1.5')],
              [
                ...(canShow
                  ? [
                      model.shown.includes(run.id)
                        ? smallButton(`changes-${run.id}`, 'Hide changes', Message.ClickedHideChanges({ runId: run.id }), 'ghost', h)
                        : smallButton(`changes-${run.id}`, 'Show changes', Message.ClickedShowChanges({ runId: run.id }), 'ghost', h),
                    ]
                  : []),
                ...(canUndo ? [smallButton(`undo-${run.id}`, 'Undo', Message.ClickedUndo({ runId: run.id }), 'outline', h)] : []),
              ],
            ),
          ]
        : []),
    ],
  )
}

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

const settingsHistory = (
  changes: ReadonlyArray<SettingsChange>,
  extensions: ReadonlyArray<ExtensionStatus>,
  canChange: boolean,
  h: HtmlBuilder<Message>,
): Html =>
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
                  ...(change.state === 'applied' && canChange
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

const titleOfSlot = (slot: string) => CUSTOMIZATIONS.find(each => each.slot === slot)?.title ?? slot

/** What an extension adds to the app, as short phrases. */
const addsOf = (model: Model, id: string): ReadonlyArray<string> => [
  ...model.pages.filter(page => page.owner === id).map(page => `page ${page.paths.join(', ')}`),
  ...model.inventory.nav.filter(nav => nav.owner === id).map(nav => `sidebar entry "${nav.entry.label}"`),
  ...[...model.inventory.slots, ...model.inventory.badges].filter(entry => entry.owner === id).map(entry => titleOfSlot(entry.slot).toLowerCase()),
  ...model.inventory.commands
    .filter(command => command.owner === id)
    .map(command => `command ${command.id}${command.roles === null ? '' : ` (${command.roles.join(', ')} only)`}`),
]

const extensionRow = (extension: ExtensionStatus, model: Model, h: HtmlBuilder<Message>): Html => {
  const editing = model.editing
  const canChange = admin(model)
  const adds = addsOf(model, extension.id)
  return h.li(
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
      ...(extension.description === null ? [] : [h.p([h.Class('mt-0.5 text-[11.5px] text-muted-foreground')], [extension.description])]),
      ...(adds.length === 0
        ? []
        : [h.p([h.Id(`extension-adds-${extension.id}`), h.Class('mt-0.5 text-[11px]')], [h.span([h.Class('text-muted-foreground')], ['Adds: ']), adds.join(' · ')])]),
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
                  ...(canChange
                    ? [
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
                      ]
                    : []),
                ],
              ),
            ]),
    ],
  )
}

/** Who fills one way to customize now: extension names, or the app. */
const filledBy = (model: Model, customization: Customization): ReadonlyArray<string> => {
  const nameOf = (owner: string | null) =>
    owner === null ? 'the app' : (model.extensions.find(extension => extension.id === owner)?.name ?? owner)
  const owners =
    customization.slot !== null
      ? [...model.inventory.slots, ...model.inventory.badges].filter(entry => entry.slot === customization.slot).map(entry => entry.owner)
      : customization.id === 'page'
        ? model.pages.map(page => page.owner).filter(owner => owner !== null)
        : model.extensions.filter(extension => extension.settings.length > 0).map(extension => extension.id)
  return [...new Set(owners)].map(nameOf)
}

/** Every place an extension can change the app, as bb lists a plugin's
 *  capabilities: where it shows, what is in it now, and an example. */
const customizeView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Id('workshop-customize')],
    [
      h.h2([h.Class('mb-1 text-[12px] font-medium text-muted-foreground')], ['What you can customize']),
      h.ul(
        [h.Class('grid gap-2 sm:grid-cols-2')],
        CUSTOMIZATIONS.map(customization => {
          const now = filledBy(model, customization)
          return h.li(
            [
              h.Id(`customize-${customization.id.replace(/[^A-Za-z0-9_-]/g, '-')}`),
              h.DataAttribute('slot', customization.slot ?? ''),
              h.Class('flex flex-col gap-1 rounded-lg border bg-card p-3'),
            ],
            [
              h.div(
                [h.Class('flex items-center gap-2')],
                [
                  h.span([h.Class('flex-1 text-[13px] font-medium')], [customization.title]),
                  ...(customization.slot === null ? [] : [h.code([h.Class('text-[10.5px] text-muted-foreground')], [customization.slot])]),
                ],
              ),
              h.p([h.Class('text-[12px] text-muted-foreground')], [customization.where]),
              h.p([h.Class('text-[11.5px]')], [h.span([h.Class('text-muted-foreground')], ['Now: ']), now.length === 0 ? 'nothing yet' : now.join(', ')]),
              h.div(
                [h.Class('mt-auto flex items-center justify-end gap-1.5 pt-1')],
                [
                  ...(customization.seeAt === null
                    ? []
                    : [h.a([h.Href(customization.seeAt), h.Class('text-[11.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline')], ['See it'])]),
                  ...(admin(model)
                    ? [
                        button(
                          {
                            id: `try-${customization.id.replace(/[^A-Za-z0-9_-]/g, '-')}`,
                            children: ['Try an example'],
                            variant: 'outline',
                            size: 'sm',
                            class: 'h-6 text-[11px]',
                            onClick: Message.ClickedTryExample({ id: customization.id }),
                          },
                          h,
                        ),
                      ]
                    : []),
                ],
              ),
            ],
          )
        }),
      ),
    ],
  )

const membersView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Id('workshop-members')],
    [
      h.h2([h.Class('mb-1 text-[12px] font-medium text-muted-foreground')], ['People']),
      h.ul(
        [h.Class('divide-y')],
        model.members.map(member =>
          h.li(
            [h.Id(`member-${member.id}`), h.Class('flex items-center gap-2 py-1.5 text-[12px]'), h.DataAttribute('role', member.role)],
            [
              h.span([h.Class('min-w-0 flex-1 truncate')], [member.name]),
              badge(h, isAdmin(member) ? 'Administrator' : 'Member', isAdmin(member) ? STATE_CLASS.review : STATE_CLASS.queued),
              ...(admin(model) && member.id !== model.shell.me.id
                ? [
                    button(
                      {
                        id: `role-${member.id}`,
                        children: [isAdmin(member) ? 'Make member' : 'Make administrator'],
                        variant: 'ghost',
                        size: 'sm',
                        class: 'h-6 text-[11px]',
                        onClick: Message.ClickedSetRole({ memberId: member.id, role: isAdmin(member) ? 'member' : 'admin' }),
                      },
                      h,
                    ),
                  ]
                : []),
            ],
          ),
        ),
      ),
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
              region(h, {
                id: 'workshop-form',
                deps: [model.prompt, model.notice, admin(model), model.members],
                render: () => (admin(model) ? promptForm(model, h) : membersNote(model, h)),
              }),
              region(h, {
                id: 'workshop-customize',
                deps: [model.inventory, model.pages, model.extensions, admin(model)],
                render: () => customizeView(model, h),
              }),
              h.h2([h.Class('-mb-1 text-[12px] font-medium text-muted-foreground')], ['Changes']),
              region(h, {
                id: 'workshop-runs',
                deps: [model.runs, model.diffs, model.shown, admin(model)],
                render: () =>
                  h.div(
                    [h.Id('workshop-runs'), h.Class('flex flex-col gap-3')],
                    model.runs.length === 0
                      ? [h.p([h.Class('text-[13px] text-muted-foreground')], ['No changes yet.'])]
                      : model.runs.map(run => runView(run, model, h)),
                  ),
              }),
            ],
          ),
          h.div(
            [h.Class('flex min-w-0 flex-col gap-6')],
            [
              region(h, {
                id: 'workshop-extensions',
                deps: [model.extensions, model.editing, model.settingsChanges, admin(model), model.inventory, model.pages],
                render: () =>
                  h.section(
                    [h.Id('workshop-extensions')],
                    [
                      h.h2([h.Class('mb-1 text-[12px] font-medium text-muted-foreground')], ['Loaded extensions']),
                      h.ul([h.Class('divide-y')], model.extensions.map(extension => extensionRow(extension, model, h))),
                      settingsHistory(model.settingsChanges, model.extensions, admin(model), h),
                    ],
                  ),
              }),
              region(h, {
                id: 'workshop-members',
                deps: [model.members, model.shell.me],
                render: () => membersView(model, h),
              }),
            ],
          ),
        ],
      ),
    ],
    h,
  ),
})

export const program: Program<Model, Message, ClientMessage, Flags, Workspace | Contributions | Changes | Extensions | PageHost> = {
  name: 'workshop',
  Model,
  ClientMessage,
  flags: request =>
    Effect.gen(function* () {
      const shell = yield* loadShell(request)
      const runs = yield* Changes.use(changes => changes.current)
      const extensions = yield* Extensions.use(extensions => extensions.current)
      const settingsChanges = yield* Extensions.use(extensions => extensions.currentSettingsChanges)
      const members = (yield* Workspace.use(workspace => workspace.current)).members
      const inventory = yield* Contributions.use(contributions => contributions.inventory)
      const pages = yield* PageHost.use(host => host.pages)
      return { shell, runs, extensions, settingsChanges, members, inventory, pages }
    }),
  init,
  update,
  view,
  subscriptions,
  snapshotDeps: model => [model.prompt, model.editing, model.notice, model.shown],
}
