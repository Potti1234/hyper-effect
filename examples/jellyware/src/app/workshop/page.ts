import { Effect, Match as M, Schema as S, Stream } from 'effect'
import { Command, Subscription, type Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import * as Navigation from 'foldkit/navigation'

import { PageHost, PageNotFound, type PageRequest, type Program, memoizeLast, region } from '@hyper-effect/core'
import {
  Activity,
  type ActivityState,
  Changes,
  Contributions,
  type DiffLine,
  ExtensionStatus,
  Extensions,
  FileDiff,
  Inventory,
  MemberSettings,
  Run,
  type SettingField,
  SettingsChange,
  isMemberSetting,
  parseDeclared,
  threadOf,
} from '@hyper-effect/jellyware'

import * as Icon from '@/lib/icon'
import { renderTextarea } from '@/lib/textarea'
import { cn } from '@/lib/utils'
import { button } from '@/ui/button'

import { Member, Role } from '../domain'
import { CUSTOMIZATIONS, type Customization, Shell, frame, isAdmin, loadShell, shellChanges } from '../extensions'
import { Workspace } from '../store'

/* Manage extensions, in five sections behind a second sidebar, each at a
   path of its own (links move between them within the session):

   - Extensions (/extensions): every extension with what it adds, its
     settings (with their history and undo) and the member's own settings;
     administrators turn extensions off and on.
   - Chat (/extensions/chat, /extensions/chat/<run>): conversations with
     the agent. Each prompt is a run; while it works the page shows what the
     agent says, every tool it calls and each step of the pipeline (attempts,
     checks, review, install) as they happen. A message in a conversation
     follows up its newest run; the agent carries on from it. A run waiting
     for review is approved or rejected right there.
   - Changes (/extensions/changes): every run, newest first, with its diff,
     review and undo.
   - Customize (/extensions/customize): every place an extension can change
     (CUSTOMIZATIONS in src/app/extensions.ts), what is in it now, and an
     example prompt.
   - People (/extensions/people): who may change the app.

   Administrators do all of that and give others the role; members follow
   the conversations, see the runs and extensions and change their own
   settings. update checks the role for every Message a browser posts, from
   the member as the server knows them (the shell's Subscription keeps it
   current). */

export const PATH = '/extensions'
/** The other paths of the page: its sections, and a conversation. */
export const PATHS = [`${PATH}/:section`, `${PATH}/chat/:thread`]

// MODEL

export const SECTIONS = ['extensions', 'chat', 'changes', 'customize', 'people'] as const
export const Section = S.Literals(SECTIONS)
export type Section = typeof Section.Type

/** The page's path for a section, or a conversation. */
export const pathOf = (section: Section, thread: string | null = null): string =>
  section === 'extensions' ? PATH : section === 'chat' && thread !== null ? `${PATH}/chat/${thread}` : `${PATH}/${section}`

const isSection = (text: string): text is Section => SECTIONS.some(section => section === text)

/** The section and conversation of a URL; null for a path the page does
 *  not serve. */
export const locate = (url: URL): Readonly<{ section: Section; thread: string | null }> | null => {
  const parts = url.pathname.split('/').filter(part => part !== '').slice(1)
  if (parts.length === 0) return { section: 'extensions', thread: null }
  const [section = '', thread] = parts
  if (!isSection(section)) return null
  if (thread !== undefined) return section === 'chat' && parts.length === 2 ? { section, thread: decodeURIComponent(thread) } : null
  return { section, thread: null }
}

/** A page served by the page host, and the extension that mounted it. */
const HostedPage = S.Struct({ name: S.String, paths: S.Array(S.String), owner: S.NullOr(S.String) })
type HostedPage = typeof HostedPage.Type

/** The settings form open for one extension: the text of each field, and
 *  whether it is the member's own settings or the extension's (for
 *  administrators). A secret's text is what was typed to replace it. */
const Editing = S.Struct({
  extension: S.String,
  values: S.Record(S.String, S.String),
  mine: S.Boolean.pipe(S.withDecodingDefaultKey(Effect.succeed(false))),
})
type Editing = typeof Editing.Type

export const Model = S.Struct({
  shell: Shell,
  section: Section,
  /** The conversation open in Chat (the id of its first run); null for a
   *  new one. */
  thread: S.NullOr(S.String),
  runs: S.Array(Run),
  /** What happened in the runs of the open conversation, by run id. */
  activity: S.Record(S.String, S.Array(Activity)),
  extensions: S.Array(ExtensionStatus),
  settingsChanges: S.Array(SettingsChange),
  members: S.Array(Member),
  /** What extensions registered, and the pages they serve. */
  inventory: Inventory,
  pages: S.Array(HostedPage),
  /** The member settings of every extension as this member has them. */
  mySettings: S.Array(MemberSettings),
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

/** Runs that are not over yet. */
const BUSY: ReadonlySet<Run['state']> = new Set(['queued', 'working', 'checking'])

/** The runs of a conversation, oldest first. */
const runsOf = (runs: ReadonlyArray<Run>, thread: string | null): ReadonlyArray<Run> =>
  thread === null ? [] : runs.filter(run => threadOf(run) === thread).reverse()

/** Whether the agent still works on a conversation. */
const isBusy = (runs: ReadonlyArray<Run>, thread: string | null) => runsOf(runs, thread).some(run => BUSY.has(run.state))

/** The conversations, the latest first: the first run, and the newest. */
const conversations = (runs: ReadonlyArray<Run>) => {
  const seen = new Map<string, { first: Run | undefined; newest: Run }>()
  for (const run of runs) {
    const thread = threadOf(run)
    const known = seen.get(thread)
    if (known === undefined) seen.set(thread, { first: run.thread === null ? run : undefined, newest: run })
    else if (run.thread === null) known.first = run
  }
  return [...seen.entries()].map(([thread, { first, newest }]) => ({ thread, title: (first ?? newest).prompt, newest }))
}

// MESSAGE

export const Message = defineMessageUnion({
  ChangedUrl: { section: Section, thread: S.NullOr(S.String) },
  ChangedPrompt: { text: S.String },
  SubmittedPrompt: {},
  ClickedUndo: { runId: S.String },
  ClickedApprove: { runId: S.String },
  ClickedReject: { runId: S.String },
  ClickedShowChanges: { runId: S.String },
  ClickedHideChanges: { runId: S.String },
  ClickedSetRole: { memberId: S.String, role: Role },
  ClickedTryExample: { id: S.String },
  ClickedToggleExtension: { extension: S.String },
  ClickedClearSecret: { key: S.String },
  ClickedEditMine: { extension: S.String },
  ClickedResetMine: { extension: S.String },
  GotMySettings: { settings: S.Array(MemberSettings) },
  GotInventory: { inventory: Inventory },
  GotPages: { pages: S.Array(HostedPage) },
  GotShell: { shell: Shell },
  GotMembers: { members: S.Array(Member) },
  GotDiffs: { diffs: S.Record(S.String, S.Array(FileDiff)) },
  GotRuns: { runs: S.Array(Run) },
  GotActivity: { runId: S.String, activity: S.Array(Activity) },
  GotExtensions: { extensions: S.Array(ExtensionStatus) },
  GotSettingsChanges: { changes: S.Array(SettingsChange) },
  ClickedEditSettings: { extension: S.String },
  ClickedCancelSettings: {},
  ChangedSetting: { key: S.String, value: S.String },
  ClickedToggleSetting: { key: S.String },
  SubmittedSettings: {},
  ClickedUndoSettings: { changeId: S.String },
  CompletedSettings: { message: S.String },
  SucceededStart: { runId: S.String, thread: S.NullOr(S.String) },
  FailedStart: { message: S.String },
  SucceededUndo: {},
  FailedUndo: { message: S.String },
  SucceededReview: {},
  FailedReview: { message: S.String },
  SucceededRole: {},
  FailedRole: { message: S.String },
  CompletedBrowserAction: {},
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
  Message.ClickedToggleExtension,
  Message.ClickedClearSecret,
  Message.ClickedEditMine,
  Message.ClickedResetMine,
  Message.ClickedEditSettings,
  Message.ClickedCancelSettings,
  Message.ClickedToggleSetting,
  Message.SubmittedSettings,
  Message.ClickedUndoSettings,
])
export type ClientMessage = typeof ClientMessage.Type

// COMMAND

/** Starts a run: a new conversation, or a follow-up in `thread`. */
export const StartRun = Command.define('Workshop.StartRun', {
  args: { prompt: S.String, author: S.String, thread: S.NullOr(S.String) },
  messages: [Message.SucceededStart, Message.FailedStart],
  execute: ({ prompt, author, thread }) =>
    Changes.use(changes => changes.start(prompt, author, thread ?? undefined)).pipe(
      Effect.map(runId => Message.SucceededStart({ runId, thread })),
      Effect.catchTag('StartRefused', error => Effect.succeed(Message.FailedStart({ message: error.message }))),
    ),
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

/** Turns an extension off or on. */
export const SetEnabled = Command.define('Workshop.SetEnabled', {
  args: { extension: S.String, enabled: S.Boolean },
  messages: [Message.CompletedSettings],
  execute: ({ extension, enabled }) =>
    Extensions.use(extensions => extensions.setEnabled(extension, enabled)).pipe(
      Effect.as(enabled ? 'Turned on.' : 'Turned off. Its files, settings and data are kept.'),
      Effect.catch(message => Effect.succeed(message)),
      Effect.map(message => Message.CompletedSettings({ message })),
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

export const ClearSecret = Command.define('Workshop.ClearSecret', {
  args: { extension: S.String, key: S.String, author: S.String },
  messages: [Message.CompletedSettings],
  execute: ({ extension, key, author }) =>
    Extensions.use(extensions => extensions.clearSecrets(extension, [key], author)).pipe(
      Effect.map(change => (change.state === 'applied' ? 'Removed. The extension runs without it.' : `Put back: ${change.error ?? ''}`)),
      Effect.catch(message => Effect.succeed(message)),
      Effect.map(message => Message.CompletedSettings({ message })),
    ),
})

/** A member's own values of member settings: no new build of the
 *  extension, so no put-back either. */
export const ConfigureMine = Command.define('Workshop.ConfigureMine', {
  args: { extension: S.String, memberId: S.String, values: S.Record(S.String, S.String) },
  messages: [Message.CompletedSettings],
  execute: ({ extension, memberId, values }) =>
    Extensions.use(extensions => extensions.configureMember(extension, memberId, values)).pipe(
      Effect.as('Saved your settings.'),
      Effect.catch(message => Effect.succeed(message)),
      Effect.map(message => Message.CompletedSettings({ message })),
    ),
})

export const ResetMine = Command.define('Workshop.ResetMine', {
  args: { extension: S.String, memberId: S.String },
  messages: [Message.CompletedSettings],
  execute: ({ extension, memberId }) =>
    Extensions.use(extensions => extensions.resetMember(extension, memberId)).pipe(
      Effect.as('Back on the defaults.'),
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

/** Forwarded to the page (see `clientCommands`): the address bar follows a
 *  new conversation. */
export const ReplaceUrl = Command.define('Workshop.ReplaceUrl', {
  args: { url: S.String },
  messages: [Message.CompletedBrowserAction],
  execute: ({ url }) => Navigation.replaceUrl(url).pipe(Effect.as(Message.CompletedBrowserAction())),
})

/** Forwarded too: a new entry in the history, so back returns. */
export const PushUrl = Command.define('Workshop.PushUrl', {
  args: { url: S.String },
  messages: [Message.CompletedBrowserAction],
  execute: ({ url }) => Navigation.pushUrl(url).pipe(Effect.as(Message.CompletedBrowserAction())),
})

// INIT

type Flags = Readonly<{
  shell: Shell
  section: Section
  thread: string | null
  runs: ReadonlyArray<Run>
  extensions: ReadonlyArray<ExtensionStatus>
  settingsChanges: ReadonlyArray<SettingsChange>
  members: ReadonlyArray<Member>
  inventory: Inventory
  pages: ReadonlyArray<HostedPage>
  mySettings: ReadonlyArray<MemberSettings>
}>

export const init = (flags: Flags): Update.Return<Model, Message> => ({
  model: {
    shell: flags.shell,
    section: flags.section,
    thread: flags.thread,
    runs: flags.runs,
    activity: {},
    extensions: flags.extensions,
    settingsChanges: flags.settingsChanges,
    members: flags.members,
    inventory: flags.inventory,
    pages: flags.pages,
    mySettings: flags.mySettings,
    diffs: {},
    shown: [],
    prompt: '',
    editing: null,
    notice: null,
  },
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Changes | Extensions | Workspace>

/** The form's text for fields: a secret starts empty (empty keeps it). */
const formValues = (fields: ReadonlyArray<SettingField>): Readonly<Record<string, string>> =>
  Object.fromEntries(fields.map(field => [field.key, field.spec.type === 'secret' ? '' : String(field.value)]))

/** Runs whose changes can be shown: those that got as far as review or
 *  install. */
const HAS_DIFF: ReadonlySet<Run['state']> = new Set(['review', 'installed', 'undone', 'rejected', 'failed'])

const runWith = (model: Model, runId: string, states: ReadonlySet<Run['state']>) =>
  model.runs.find(run => run.id === runId && states.has(run.state) && run.changes.length > 0)

const REVIEW: ReadonlySet<Run['state']> = new Set(['review'])
const INSTALLED: ReadonlySet<Run['state']> = new Set(['installed'])

/** The conversation a run id opens: the thread of a known run. */
const threadFor = (runs: ReadonlyArray<Run>, id: string | null): string | null => {
  if (id === null) return null
  const found = runs.find(run => run.id === id)
  return found === undefined ? null : threadOf(found)
}

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      // A link to another section or conversation, or back and forward.
      ChangedUrl: ({ section, thread }) => {
        const open = threadFor(model.runs, thread)
        return {
          model: {
            ...model,
            section,
            thread: open,
            activity: open === model.thread ? model.activity : {},
            notice: null,
            editing: section === model.section ? model.editing : null,
          },
        }
      },
      ChangedPrompt: ({ text }) => ({ model: { ...model, prompt: text } }),
      // Every Message a browser posts that changes the app checks the role.
      // A message in a conversation follows up its newest run, once that is
      // over.
      SubmittedPrompt: () => {
        if (!admin(model) || model.section !== 'chat') return { model }
        const prompt = model.prompt.trim()
        if (prompt === '') return { model: { ...model, notice: 'Describe the change first.' } }
        if (isBusy(model.runs, model.thread)) {
          return { model: { ...model, notice: 'The agent is still working on this conversation. Wait until it is done.' } }
        }
        return {
          model: { ...model, prompt: '', notice: null },
          commands: [StartRun({ prompt, author: model.shell.me.name, thread: model.thread })],
        }
      },
      // A new conversation opens once its first run exists.
      SucceededStart: ({ runId, thread }) =>
        thread === null && model.section === 'chat' && model.thread === null
          ? { model: { ...model, thread: runId, activity: {} }, commands: [ReplaceUrl({ url: pathOf('chat', runId) })] }
          : { model },
      FailedStart: ({ message }) => ({ model: { ...model, notice: message } }),
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
      // Opens a new conversation with the example of one way to customize
      // the app in the prompt.
      ClickedTryExample: ({ id }) => {
        const found = CUSTOMIZATIONS.find(each => each.id === id)
        if (!admin(model) || found === undefined) return { model }
        const moved = model.section !== 'chat' || model.thread !== null
        return {
          model: { ...model, section: 'chat', thread: null, activity: {}, prompt: found.example, notice: null, editing: null },
          commands: moved ? [PushUrl({ url: pathOf('chat') })] : [],
        }
      },
      ClickedToggleExtension: ({ extension }) => {
        const found = model.extensions.find(other => other.id === extension)
        if (!admin(model) || found === undefined) return { model }
        const enabled = found.state === 'disabled'
        return {
          model: { ...model, notice: enabled ? `Turning ${found.name} on…` : `Turning ${found.name} off…` },
          commands: [SetEnabled({ extension, enabled })],
        }
      },
      GotInventory: ({ inventory }) => ({ model: { ...model, inventory } }),
      GotPages: ({ pages }) => ({ model: { ...model, pages } }),
      // A member who loses the role mid-edit loses the extension's form.
      GotShell: ({ shell }) => ({
        model: { ...model, shell, editing: isAdmin(shell.me) || model.editing?.mine === true ? model.editing : null },
      }),
      GotMembers: ({ members }) => ({ model: { ...model, members } }),
      GotDiffs: ({ diffs }) => ({ model: { ...model, diffs } }),
      GotRuns: ({ runs }) => ({ model: { ...model, runs } }),
      // Only for the runs of the open conversation.
      GotActivity: ({ runId, activity }) =>
        runsOf(model.runs, model.thread).some(run => run.id === runId)
          ? { model: { ...model, activity: { ...model.activity, [runId]: activity } } }
          : { model },
      GotExtensions: ({ extensions }) => ({ model: { ...model, extensions } }),
      GotSettingsChanges: ({ changes }) => ({ model: { ...model, settingsChanges: changes } }),
      // Posted by a browser: only an extension with settings.
      ClickedEditSettings: ({ extension }) => {
        if (!admin(model)) return { model }
        const found = model.extensions.find(other => other.id === extension)
        if (found === undefined || found.settings.length === 0) return { model }
        return { model: { ...model, editing: { extension, values: formValues(found.settings), mine: false }, notice: null } }
      },
      // Every member, for their own values of member settings.
      ClickedEditMine: ({ extension }) => {
        const found = model.mySettings.find(other => other.extension === extension)
        if (found === undefined) return { model }
        return { model: { ...model, editing: { extension, values: formValues(found.fields), mine: true }, notice: null } }
      },
      ClickedResetMine: ({ extension }) =>
        model.mySettings.some(other => other.extension === extension && other.own.length > 0)
          ? { model: { ...model, editing: null, notice: null }, commands: [ResetMine({ extension, memberId: model.shell.me.id })] }
          : { model },
      ClickedClearSecret: ({ key }) => {
        const editing = model.editing
        if (editing === null || editing.mine || !admin(model)) return { model }
        const field = model.extensions.find(other => other.id === editing.extension)?.settings.find(other => other.key === key)
        return field === undefined || field.spec.type !== 'secret' || !field.isSet
          ? { model }
          : {
              model: { ...model, editing: null, notice: 'Loading the extension without it…' },
              commands: [ClearSecret({ extension: editing.extension, key, author: model.shell.me.name })],
            }
      },
      GotMySettings: ({ settings }) => ({ model: { ...model, mySettings: settings } }),
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
          : model.editing.mine
            ? {
                model: { ...model, editing: null, notice: null },
                commands: [ConfigureMine({ extension: model.editing.extension, memberId: model.shell.me.id, values: model.editing.values })],
              }
            : !admin(model)
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
      SucceededUndo: () => ({ model }),
      FailedUndo: ({ message }) => ({ model: { ...model, notice: message } }),
      SucceededReview: () => ({ model }),
      FailedReview: ({ message }) => ({ model: { ...model, notice: message } }),
      SucceededRole: () => ({ model }),
      FailedRole: ({ message }) => ({ model: { ...model, notice: message } }),
      CompletedBrowserAction: () => ({ model }),
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
  mySettings: entry(
    { memberId: S.String },
    {
      modelToDependencies: model => ({ memberId: model.shell.me.id }),
      dependenciesToStream: ({ memberId }) =>
        Stream.unwrap(
          Extensions.use(extensions =>
            Effect.succeed(extensions.memberSettings(memberId).pipe(Stream.map(settings => Message.GotMySettings({ settings })))),
          ),
        ),
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
  // What the runs of the open conversation do, as it happens.
  activity: entry(
    { runIds: S.Array(S.String) },
    {
      modelToDependencies: model => ({
        runIds: model.section === 'chat' ? runsOf(model.runs, model.thread).map(run => run.id) : [],
      }),
      dependenciesToStream: ({ runIds }) =>
        Stream.unwrap(
          Changes.use(changes =>
            Effect.succeed(
              Stream.mergeAll(
                runIds.map(runId => changes.activity(runId).pipe(Stream.map(activity => Message.GotActivity({ runId, activity })))),
                { concurrency: 'unbounded' },
              ),
            ),
          ),
        ),
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

/** A dot for a run's state in lists. */
const STATE_DOT: Readonly<Record<Run['state'], string>> = {
  queued: 'bg-muted-foreground/40',
  working: 'bg-blue-500 animate-pulse',
  checking: 'bg-blue-500 animate-pulse',
  review: 'bg-amber-500',
  installing: 'bg-blue-500 animate-pulse',
  installed: 'bg-emerald-500',
  unchanged: 'bg-muted-foreground/40',
  failed: 'bg-destructive',
  rejected: 'bg-muted-foreground/40',
  undone: 'bg-muted-foreground/40',
}

const badge = (h: HtmlBuilder<Message>, text: string, className: string): Html =>
  h.span([h.Class(cn('rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap', className))], [text])

const time = (millis: number) => new Date(millis).toISOString().slice(0, 16).replace('T', ' ')

/** A duration as "4s" or "1m 12s". */
const duration = (from: number, until: number) => {
  const seconds = Math.max(0, Math.round((until - from) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

const heading = (h: HtmlBuilder<Message>, text: string, more: ReadonlyArray<Html> = []): Html =>
  h.div(
    [h.Class('mb-2 flex items-center gap-2')],
    [h.h2([h.Class('flex-1 text-[12px] font-medium text-muted-foreground')], [text]), ...more],
  )

// THE SECOND SIDEBAR

const SECTION_LABEL: Readonly<Record<Section, string>> = {
  extensions: 'Extensions',
  chat: 'Chat',
  changes: 'Changes',
  customize: 'Customize',
  people: 'People',
}

const SECTION_ICON: Readonly<Record<Section, string>> = {
  extensions: 'blocks',
  chat: 'message-square',
  changes: 'git-branch',
  customize: 'sparkles',
  people: 'users',
}

const NAV_ITEM =
  'group flex h-7 w-full items-center gap-2 rounded-md px-2 text-[13px] font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-foreground'

const sectionNav = (model: Model, h: HtmlBuilder<Message>): Html => {
  const inReview = model.runs.filter(run => run.state === 'review').length
  const working = model.runs.filter(run => BUSY.has(run.state)).length
  const count: Readonly<Record<Section, Html | null>> = {
    extensions: h.span([h.Class('text-[11px] tabular-nums text-muted-foreground')], [String(model.extensions.length)]),
    chat: working === 0 ? null : h.span([h.Class('size-1.5 rounded-full bg-blue-500 animate-pulse'), h.AriaLabel(`${working} working`)], []),
    changes:
      inReview === 0
        ? null
        : h.span([h.Class('rounded bg-amber-500/15 px-1 text-[11px] tabular-nums text-amber-700 dark:text-amber-400'), h.Title('Waiting for review')], [String(inReview)]),
    customize: null,
    people: h.span([h.Class('text-[11px] tabular-nums text-muted-foreground')], [String(model.members.length)]),
  }
  const item = (section: Section) =>
    h.a(
      [
        h.Id(`section-${section}`),
        h.Href(pathOf(section)),
        h.Class(cn(NAV_ITEM, model.section === section && 'bg-accent text-foreground')),
        ...(model.section === section ? [h.AriaCurrent('page')] : []),
      ],
      [
        h.span([h.Class('flex w-4 shrink-0 justify-center text-muted-foreground group-hover:text-foreground')], [
          Icon.icon(SECTION_ICON[section], { class: 'size-4' }, h),
        ]),
        h.span([h.Class('flex-1 truncate')], [SECTION_LABEL[section]]),
        ...(count[section] === null ? [] : [count[section]]),
      ],
    )
  const threads = conversations(model.runs).slice(0, 12)
  return h.nav(
    [h.Id('workshop-nav'), h.AriaLabel('Manage extensions'), h.Class('flex w-56 shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-2')],
    [
      item('extensions'),
      item('chat'),
      // Conversations under Chat, the latest first.
      h.div(
        [h.Id('workshop-threads'), h.Class('flex flex-col gap-px pl-4')],
        [
          ...(admin(model)
            ? [
                h.a(
                  [
                    h.Id('new-chat'),
                    h.Href(pathOf('chat')),
                    h.Class(cn(NAV_ITEM, 'h-6 text-[12px] font-normal', model.section === 'chat' && model.thread === null && 'bg-accent text-foreground')),
                  ],
                  [Icon.icon('plus', { class: 'size-3.5 text-muted-foreground' }, h), h.span([h.Class('flex-1')], ['New conversation'])],
                ),
              ]
            : []),
          ...threads.map(({ thread, title, newest }) =>
            h.a(
              [
                h.Id(`thread-${thread}`),
                h.Href(pathOf('chat', thread)),
                h.Title(title),
                h.Class(cn(NAV_ITEM, 'h-6 text-[12px] font-normal', model.section === 'chat' && model.thread === thread && 'bg-accent text-foreground')),
                ...(model.section === 'chat' && model.thread === thread ? [h.AriaCurrent('page')] : []),
              ],
              [
                h.span([h.Class(cn('size-1.5 shrink-0 rounded-full', STATE_DOT[newest.state])), h.Title(STATE_LABEL[newest.state])], []),
                h.span([h.Class('min-w-0 flex-1 truncate')], [title]),
              ],
            ),
          ),
        ],
      ),
      item('changes'),
      item('customize'),
      item('people'),
    ],
  )
}

// RUNS, DIFFS AND REVIEW

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
              [h.Class('overflow-hidden rounded-md border bg-card'), h.DataAttribute('file', `${file.extension}/${file.path}`)],
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

const changeChips = (run: Run, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  run.changes.length === 0
    ? []
    : [
        h.ul(
          [h.Class('flex flex-wrap gap-1.5')],
          run.changes.map(change => h.li([h.Class('rounded border px-1.5 py-0.5 font-mono text-[11px]')], [`${change.id} ${change.action}`])),
        ),
      ]

/** The diff, review and undo of a run, as Changes and Chat show them. */
const runActions = (run: Run, model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  // A decided run's changes open on request; a run in review shows them.
  const canShow = run.state !== 'review' && HAS_DIFF.has(run.state) && run.changes.length > 0
  const canUndo = run.state === 'installed' && admin(model)
  return [
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
  ]
}

/** A run in Changes: what was asked, what came of it. */
const runView = (run: Run, model: Model, h: HtmlBuilder<Message>): Html =>
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
        [h.Class('mt-1 flex items-center gap-1 text-[11px] text-muted-foreground')],
        [
          h.span([h.Class('flex-1')], [
            `${run.author} · ${time(run.startedAt)} UTC${run.attempts > 1 ? ` · ${run.attempts} attempts` : ''}${
              run.reviewer === null ? '' : ` · ${run.state === 'rejected' ? 'rejected' : 'approved'} by ${run.reviewer}`
            }${run.thread === null ? '' : ' · follow-up'}`,
          ]),
          h.a(
            [
              h.Id(`open-chat-${run.id}`),
              h.Href(pathOf('chat', threadOf(run))),
              h.Class('inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline'),
            ],
            [Icon.icon('message-square', { class: 'size-3' }, h), 'Conversation'],
          ),
        ],
      ),
      ...(run.changes.length === 0 ? [] : [h.div([h.Class('mt-2')], changeChips(run, h))]),
      ...(run.summary === null ? [] : [h.p([h.Class('mt-2 text-[12.5px] whitespace-pre-wrap')], [run.summary])]),
      ...(run.error === null
        ? []
        : [h.pre([h.Class('mt-2 max-h-48 overflow-auto rounded bg-destructive/5 p-2 text-[11px] whitespace-pre-wrap text-destructive')], [run.error])]),
      ...runActions(run, model, h),
    ],
  )

const changesSection = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('mx-auto w-full max-w-3xl p-4')],
    [
      heading(h, 'Every change made by prompt, newest first'),
      h.div(
        [h.Id('workshop-runs'), h.Class('flex flex-col gap-3')],
        model.runs.length === 0
          ? [h.p([h.Class('text-[13px] text-muted-foreground')], ['No changes yet. Start one in Chat.'])]
          : model.runs.map(run => runView(run, model, h)),
      ),
    ],
  )

// CHAT

const TOOL_LABEL: Readonly<Record<string, string>> = {
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  grep: 'Search',
  find: 'Find',
  ls: 'List',
}

const TOOL_ICON: Readonly<Record<string, string>> = {
  read: 'file-text',
  edit: 'pencil',
  write: 'file-code',
  grep: 'file-search',
  find: 'file-search',
  ls: 'folder',
}

const stateIcon = (state: ActivityState, h: HtmlBuilder<Message>): Html =>
  state === 'running'
    ? Icon.icon('loader-circle', { class: 'size-3.5 animate-spin text-blue-500', ariaLabel: 'Running' }, h)
    : state === 'done'
      ? Icon.icon('circle-check', { class: 'size-3.5 text-emerald-600 dark:text-emerald-400', ariaLabel: 'Done' }, h)
      : state === 'failed'
        ? Icon.icon('circle-x', { class: 'size-3.5 text-destructive', ariaLabel: 'Failed' }, h)
        : Icon.icon('info', { class: 'size-3.5 text-muted-foreground', ariaLabel: 'Note' }, h)

const detailBlock = (detail: string, failed: boolean, h: HtmlBuilder<Message>): Html =>
  h.pre(
    [
      h.Class(
        cn(
          'mt-1 ml-5.5 max-h-48 overflow-auto rounded p-2 font-mono text-[11px] whitespace-pre-wrap',
          failed ? 'bg-destructive/5 text-destructive' : 'bg-muted/50 text-muted-foreground',
        ),
      ),
    ],
    [detail],
  )

/** One tool call: what, on which file, how it went. */
const toolRow = (entry: Extract<Activity, { _tag: 'Tool' }>, h: HtmlBuilder<Message>): Html =>
  h.li(
    [h.Class('px-2.5 py-1'), h.DataAttribute('tool', entry.name), h.DataAttribute('state', entry.state)],
    [
      h.div(
        [h.Class('flex items-center gap-2 text-[12px]')],
        [
          stateIcon(entry.state, h),
          Icon.icon(TOOL_ICON[entry.name] ?? 'wrench', { class: 'size-3.5 text-muted-foreground' }, h),
          h.span([h.Class('font-medium')], [TOOL_LABEL[entry.name] ?? entry.name]),
          h.span([h.Class('min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground'), h.Title(entry.target)], [entry.target]),
          // Only calls that took a while.
          ...(entry.until === null || entry.until - entry.at < 2000
            ? []
            : [h.span([h.Class('tabular-nums text-[11px] text-muted-foreground')], [duration(entry.at, entry.until)])]),
        ],
      ),
      ...(entry.detail === null ? [] : [detailBlock(entry.detail, true, h)]),
    ],
  )

/** A step of the pipeline: an attempt, a check, the review, the install. */
const stepRow = (entry: Extract<Activity, { _tag: 'Step' }>, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('text-[12px]'), h.DataAttribute('step', entry.id), h.DataAttribute('state', entry.state)],
    [
      h.div(
        [h.Class('flex items-center gap-2')],
        [
          stateIcon(entry.state, h),
          h.span([h.Class(cn('min-w-0 flex-1', entry.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'))], [entry.text]),
          ...(entry.until === null || entry.until === entry.at
            ? []
            : [h.span([h.Class('tabular-nums text-[11px] text-muted-foreground')], [duration(entry.at, entry.until)])]),
        ],
      ),
      ...(entry.detail === null ? [] : [detailBlock(entry.detail, entry.state === 'failed', h)]),
    ],
  )

/** What the agent said, without its `Changed:` line. */
const saidBlock = (text: string, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const said = parseDeclared(text).summary
  return said === '' ? [] : [h.div([h.Class('text-[13.5px] leading-relaxed whitespace-pre-wrap')], [said])]
}

/** A run's activity in order, consecutive tool calls in one box. */
const activityView = (entries: ReadonlyArray<Activity>, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const blocks: Array<Html> = []
  let tools: Array<Extract<Activity, { _tag: 'Tool' }>> = []
  const flush = () => {
    if (tools.length === 0) return
    blocks.push(h.ul([h.Class('divide-y rounded-lg border bg-card/60')], tools.map(tool => toolRow(tool, h))))
    tools = []
  }
  for (const entry of entries) {
    if (entry._tag === 'Tool') {
      tools.push(entry)
      continue
    }
    flush()
    if (entry._tag === 'Said') blocks.push(...saidBlock(entry.text, h))
    else blocks.push(stepRow(entry, h))
  }
  flush()
  return blocks
}

/** One run of a conversation: the message, then what the agent did. */
const chatRun = (run: Run, model: Model, h: HtmlBuilder<Message>): Html => {
  const entries = model.activity[run.id] ?? []
  const busy = BUSY.has(run.state)
  return h.article(
    [h.Id(`run-${run.id}`), h.Class('flex flex-col gap-3'), h.DataAttribute('state', run.state)],
    [
      // The message.
      h.div(
        [h.Class('flex flex-col items-end gap-1')],
        [
          h.div([h.Class('max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-[13.5px] whitespace-pre-wrap text-primary-foreground')], [run.prompt]),
          h.span([h.Class('text-[11px] text-muted-foreground')], [`${run.author} · ${time(run.startedAt)} UTC`]),
        ],
      ),
      // The agent's turn.
      h.div(
        [h.Class('flex gap-2.5')],
        [
          h.span(
            [h.Class('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border bg-card text-muted-foreground'), h.Title('The agent')],
            [Icon.icon('bot', { class: 'size-3.5' }, h)],
          ),
          h.div(
            [h.Id(`activity-${run.id}`), h.Class('flex min-w-0 flex-1 flex-col gap-2')],
            [
              ...activityView(entries, h),
              // Runs from before activity was kept: the answer and the error.
              ...(entries.length === 0 && !busy
                ? [
                    ...saidBlock(run.summary ?? '', h),
                    ...(run.error === null
                      ? []
                      : [h.pre([h.Class('max-h-48 overflow-auto rounded bg-destructive/5 p-2 text-[11px] whitespace-pre-wrap text-destructive')], [run.error])]),
                  ]
                : []),
              ...(busy
                ? [
                    h.div(
                      [h.Id(`run-status-${run.id}`), h.Class('flex items-center gap-2 text-[12px] text-muted-foreground'), h.AriaLive('polite')],
                      [
                        h.span([h.Class('flex gap-0.5')], [0, 1, 2].map(n => h.span([h.Class(cn('size-1 rounded-full bg-current animate-pulse', n === 1 && '[animation-delay:150ms]', n === 2 && '[animation-delay:300ms]'))], []))),
                        run.state === 'queued' ? 'Waiting for a free slot…' : run.state === 'checking' ? 'Checking the change…' : 'The agent is working…',
                      ],
                    ),
                  ]
                : [
                    h.div(
                      [h.Class('flex flex-wrap items-center gap-2')],
                      [
                        badge(h, STATE_LABEL[run.state], STATE_CLASS[run.state]),
                        ...changeChips(run, h),
                        ...(run.reviewer === null
                          ? []
                          : [h.span([h.Class('text-[11px] text-muted-foreground')], [`${run.state === 'rejected' ? 'rejected' : 'approved'} by ${run.reviewer}`])]),
                      ],
                    ),
                  ]),
              ...runActions(run, model, h),
            ],
          ),
        ],
      ),
    ],
  )
}

/** A new conversation: what to ask for, with examples to start from. */
const chatStart = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Id('chat-start'), h.Class('mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-4 p-6')],
    [
      h.div(
        [h.Class('flex flex-col gap-1')],
        [
          h.h2([h.Class('text-[15px] font-semibold')], ['What should change?']),
          h.p([h.Class('text-[13px] text-muted-foreground')], [
            'Describe a change to the app. The agent writes or changes an extension, the app checks it, and you read the diff before anything goes live. You see every file it reads and writes as it works.',
          ]),
        ],
      ),
      ...(admin(model)
        ? [
            h.div(
              [h.Class('grid gap-2 sm:grid-cols-2')],
              CUSTOMIZATIONS.map(customization =>
                h.button(
                  [
                    h.Id(`suggest-${customization.id.replace(/[^A-Za-z0-9_-]/g, '-')}`),
                    h.Type('button'),
                    h.OnClick(Message.ClickedTryExample({ id: customization.id })),
                    h.Class('flex flex-col gap-1 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent'),
                  ],
                  [
                    h.span([h.Class('text-[12px] font-medium')], [customization.title]),
                    h.span([h.Class('text-[12px] text-muted-foreground')], [customization.example]),
                  ],
                ),
              ),
            ),
          ]
        : []),
    ],
  )

const chatTranscript = (model: Model, h: HtmlBuilder<Message>): Html => {
  const runs = runsOf(model.runs, model.thread)
  // Column-reverse keeps the newest at the bottom in view as it grows.
  return h.div(
    [h.Id('workshop-chat'), h.Class('flex min-h-0 flex-1 flex-col-reverse overflow-y-auto')],
    [
      runs.length === 0
        ? chatStart(model, h)
        : h.div([h.Class('mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-6')], runs.map(run => chatRun(run, model, h))),
    ],
  )
}

const composer = (model: Model, h: HtmlBuilder<Message>): Html => {
  const busy = isBusy(model.runs, model.thread)
  return h.div(
    [h.Id('workshop-form'), h.Class('border-t bg-background px-4 py-3')],
    [
      h.form(
        [h.OnSubmit(Message.SubmittedPrompt()), h.Class('mx-auto max-w-3xl rounded-xl border bg-card shadow-xs focus-within:border-ring')],
        [
          renderTextarea(
            {
              id: 'workshop-prompt',
              value: model.prompt,
              placeholder:
                model.thread === null
                  ? 'Describe a change: a new page, a card on issues, a different layout of an extension…'
                  : 'Follow up: what should be different?',
              rows: 2,
              isInvalid: model.notice !== null && model.notice.includes('Describe'),
              onInput: text => Message.ChangedPrompt({ text }),
            },
            {
              field: [],
              label: [],
              textarea: [
                h.AriaLabel('Message'),
                h.Class('field-sizing-content block max-h-64 min-h-14 w-full resize-none bg-transparent px-3.5 pt-3 text-[13.5px] outline-none placeholder:text-muted-foreground'),
              ],
              description: [],
            },
            h,
          ),
          h.div(
            [h.Class('flex items-center gap-3 px-3 pt-1 pb-2.5')],
            [
              h.span([h.Id('workshop-composer-hint'), h.Class('flex-1 text-[11.5px] text-muted-foreground')], [
                busy
                  ? 'The agent is working on this conversation.'
                  : model.thread === null
                    ? 'Starts a new conversation.'
                    : 'Follows up in this conversation: the agent carries on from its last change.',
              ]),
              button({ id: 'workshop-submit', children: [model.thread === null ? 'Start' : 'Send'], type: 'submit', size: 'sm', class: 'h-7 text-[12px]' }, h),
            ],
          ),
        ],
      ),
    ],
  )
}

/** In place of the composer for members. */
const membersNote = (model: Model, h: HtmlBuilder<Message>): Html => {
  const admins = model.members.filter(isAdmin).map(member => member.name)
  return h.div(
    [h.Id('workshop-form'), h.Class('border-t px-4 py-3')],
    [
      h.p([h.Id('workshop-members-note'), h.Class('mx-auto max-w-3xl rounded-lg border border-dashed px-3.5 py-3 text-[13px] text-muted-foreground')], [
        `Only administrators change the app. Ask ${admins.join(', ') || 'an administrator'} for a change, or for the role.`,
      ]),
    ],
  )
}

// EXTENSIONS

/** Fields as "max 5, token set". */
const describeFields = (fields: ReadonlyArray<SettingField>) =>
  fields
    .map(field => `${field.key} ${field.spec.type === 'secret' ? (field.isSet ? 'set' : 'not set') : String(field.value)}`)
    .join(', ')

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

/** The form for an extension's settings (`prefix` `settings`) or a
 *  member's own (`my-settings`). */
const settingsForm = (
  prefix: 'settings' | 'my-settings',
  extension: string,
  fields: ReadonlyArray<SettingField>,
  editing: Editing,
  h: HtmlBuilder<Message>,
): Html =>
  h.form(
    [h.Id(`${prefix}-form-${extension}`), h.OnSubmit(Message.SubmittedSettings()), h.Class('mt-2 flex flex-col gap-2 rounded-md border bg-background p-2.5')],
    [
      ...fields.map(field => {
        const id = `${prefix === 'settings' ? 'setting' : 'my-setting'}-${extension}-${field.key}`
        const text = editing.values[field.key] ?? ''
        const input =
          field.spec.type === 'secret'
            ? h.div(
                [h.Class('flex items-center gap-1.5')],
                [
                  h.input([
                    h.Id(id),
                    h.Type('password'),
                    h.Autocomplete('new-password'),
                    h.Value(text),
                    h.Placeholder(field.isSet ? 'Set. Type a new value to replace it.' : 'Not set'),
                    h.Class('h-7 w-full rounded-md border bg-background px-2 text-[12px]'),
                    h.OnInput(value => Message.ChangedSetting({ key: field.key, value })),
                  ]),
                  ...(field.isSet
                    ? [
                        button(
                          {
                            id: `clear-${extension}-${field.key}`,
                            children: ['Remove'],
                            variant: 'ghost',
                            size: 'sm',
                            class: 'h-7 text-[12px]',
                            onClick: Message.ClickedClearSecret({ key: field.key }),
                          },
                          h,
                        ),
                      ]
                    : []),
                ],
              )
            : field.spec.type === 'boolean'
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
                h.span([h.Class('font-medium')], [
                  field.spec.label,
                  ...(prefix === 'settings' && isMemberSetting(field.spec)
                    ? [h.span([h.Class('font-normal text-muted-foreground')], [' · the default; each member may choose their own'])]
                    : []),
                ]),
                input,
                ...(field.spec.description === undefined ? [] : [h.span([h.Class('text-[11px] text-muted-foreground')], [field.spec.description])]),
              ],
        )
      }),
      h.div(
        [h.Class('flex justify-end gap-1.5')],
        [
          button({ id: `${prefix}-cancel-${extension}`, children: ['Cancel'], variant: 'ghost', size: 'sm', class: 'h-7 text-[12px]', onClick: Message.ClickedCancelSettings() }, h),
          button({ id: `${prefix}-save-${extension}`, children: ['Save'], type: 'submit', size: 'sm', class: 'h-7 text-[12px]' }, h),
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
    [h.Id('workshop-settings-history'), h.Class('mt-8')],
    [
      heading(h, 'Settings changes'),
      changes.length === 0
        ? h.p([h.Class('text-[12px] text-muted-foreground')], ['None yet.'])
        : h.ul(
            [h.Class('divide-y rounded-lg border bg-card px-3')],
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
                      ...(change.state === 'applied' && canChange
                        ? [
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
                          ]
                        : []),
                    ],
                  ),
                  h.p([h.Class('mt-0.5 text-[11px] text-muted-foreground')], [`${change.author} · ${time(change.at)} UTC`]),
                  ...(change.error === null
                    ? []
                    : [h.pre([h.Class('mt-1 max-h-24 overflow-auto text-[11px] whitespace-pre-wrap text-destructive')], [change.error])]),
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

const EXTENSION_STATE: Readonly<Record<ExtensionStatus['state'], readonly [string, string]>> = {
  active: ['Running', STATE_CLASS.installed],
  pending: ['Waiting', STATE_CLASS.queued],
  loading: ['Loading', STATE_CLASS.working],
  failed: ['Failed', STATE_CLASS.failed],
  disabled: ['Off', STATE_CLASS.queued],
}

/** On and off, for administrators. */
const toggle = (extension: ExtensionStatus, h: HtmlBuilder<Message>): Html => {
  const on = extension.state !== 'disabled'
  return h.button(
    [
      h.Id(`toggle-${extension.id}`),
      h.Type('button'),
      h.Role('switch'),
      h.AriaChecked(on),
      h.AriaLabel(`${extension.name} ${on ? 'on' : 'off'}`),
      h.Title(on ? 'Turn off' : 'Turn on'),
      h.OnClick(Message.ClickedToggleExtension({ extension: extension.id })),
      h.Class(cn('relative inline-flex h-4.5 w-8 shrink-0 items-center rounded-full transition-colors', on ? 'bg-primary' : 'bg-input')),
    ],
    [h.span([h.Class(cn('inline-block size-3.5 rounded-full bg-background shadow-sm transition-transform', on ? 'translate-x-4' : 'translate-x-0.5'))], [])],
  )
}

/** The member's own values of an extension's member settings. */
const mySettingsBlock = (settings: MemberSettings, model: Model, h: HtmlBuilder<Message>): Html => {
  const open = model.editing?.mine === true && model.editing.extension === settings.extension
  return h.div(
    [h.Id(`mine-${settings.extension}`), h.Class('mt-2 rounded-md bg-muted/40 px-2.5 py-2 text-[12px]')],
    [
      h.div(
        [h.Class('flex items-center gap-2')],
        [
          h.span([h.Class('flex-1 text-[11px] font-medium text-muted-foreground')], ['Your settings']),
          ...(open
            ? []
            : [
                ...(settings.own.length === 0
                  ? []
                  : [
                      button(
                        {
                          id: `mine-reset-${settings.extension}`,
                          children: ['Use defaults'],
                          variant: 'ghost',
                          size: 'sm',
                          class: 'h-6 text-[11px]',
                          onClick: Message.ClickedResetMine({ extension: settings.extension }),
                        },
                        h,
                      ),
                    ]),
                button(
                  {
                    id: `mine-edit-${settings.extension}`,
                    children: ['Change'],
                    variant: 'outline',
                    size: 'sm',
                    class: 'h-6 text-[11px]',
                    onClick: Message.ClickedEditMine({ extension: settings.extension }),
                  },
                  h,
                ),
              ]),
        ],
      ),
      model.editing !== null && open
        ? settingsForm('my-settings', settings.extension, settings.fields, model.editing, h)
        : h.p(
            [h.Id(`mine-values-${settings.extension}`), h.Class('mt-0.5 text-[11px] text-muted-foreground')],
            [
              settings.fields
                .map(field => `${field.spec.label}: ${String(field.value)}${settings.own.includes(field.key) ? ' (yours)' : ' (default)'}`)
                .join(', '),
            ],
          ),
    ],
  )
}

const extensionRow = (extension: ExtensionStatus, model: Model, h: HtmlBuilder<Message>): Html => {
  const editing = model.editing
  const canChange = admin(model)
  const adds = addsOf(model, extension.id)
  const mine = model.mySettings.find(settings => settings.extension === extension.id)
  const [label, tone] = EXTENSION_STATE[extension.state]
  return h.li(
    [
      h.Id(`extension-${extension.id}`),
      h.Class(cn('rounded-lg border bg-card p-3', extension.state === 'disabled' && 'bg-muted/30')),
      h.DataAttribute('state', extension.state),
    ],
    [
      h.div(
        [h.Class('flex items-center gap-2 text-[13px]')],
        [
          h.span([h.Class(cn('font-medium', extension.state === 'disabled' && 'text-muted-foreground'))], [extension.name]),
          badge(h, label, tone),
          h.span([h.Class('flex-1')], []),
          ...(canChange ? [toggle(extension, h)] : []),
        ],
      ),
      h.p([h.Class('mt-0.5 text-[11px] text-muted-foreground')], [
        `${extension.id} · version ${extension.version}${extension.isolated ? ' · own process' : ''}`,
      ]),
      ...(extension.description === null ? [] : [h.p([h.Class('mt-1.5 text-[12px]')], [extension.description])]),
      ...(adds.length === 0
        ? []
        : [h.p([h.Id(`extension-adds-${extension.id}`), h.Class('mt-1 text-[11px]')], [h.span([h.Class('text-muted-foreground')], ['Adds: ']), adds.join(' · ')])]),
      ...(extension.data === null
        ? []
        : [
            h.p(
              [h.Id(`extension-data-${extension.id}`), h.Class('mt-0.5 text-[11px]')],
              [
                h.span([h.Class('text-muted-foreground')], ['Data: ']),
                `${extension.data.tables.map(table => table.name).join(', ') || 'no tables'} (${extension.data.migrations} migration${extension.data.migrations === 1 ? '' : 's'})`,
              ],
            ),
          ]),
      ...(extension.state === 'disabled'
        ? [h.p([h.Class('mt-1 text-[11px] text-muted-foreground')], ['Turned off: it does not run. Its files, settings and data are kept.'])]
        : []),
      ...(extension.error === null
        ? []
        : [h.pre([h.Class('mt-1 max-h-32 overflow-auto text-[11px] whitespace-pre-wrap text-destructive')], [extension.error])]),
      ...(extension.settings.length === 0
        ? []
        : editing !== null && !editing.mine && editing.extension === extension.id
          ? [settingsForm('settings', extension.id, extension.settings, editing, h)]
          : [
              h.div(
                [h.Class('mt-2 flex items-center gap-2 border-t pt-2')],
                [
                  h.span([h.Class('text-[11px] font-medium text-muted-foreground')], ['Settings']),
                  h.span([h.Class('min-w-0 flex-1 truncate text-[11px] text-muted-foreground')], [describeFields(extension.settings)]),
                  ...(canChange
                    ? [
                        button(
                          {
                            id: `settings-${extension.id}`,
                            children: ['Change'],
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
      ...(mine === undefined ? [] : [mySettingsBlock(mine, model, h)]),
    ],
  )
}

const extensionsSection = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Id('workshop-extensions'), h.Class('mx-auto w-full max-w-3xl p-4')],
    [
      heading(h, `${model.extensions.length} extension${model.extensions.length === 1 ? '' : 's'}, ${model.extensions.filter(extension => extension.state === 'active').length} running`),
      h.ul([h.Class('flex flex-col gap-2')], model.extensions.map(extension => extensionRow(extension, model, h))),
      settingsHistory(model.settingsChanges, model.extensions, admin(model), h),
    ],
  )

// CUSTOMIZE AND PEOPLE

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
const customizeSection = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Id('workshop-customize'), h.Class('mx-auto w-full max-w-3xl p-4')],
    [
      heading(h, 'What you can customize'),
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

const peopleSection = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Id('workshop-members'), h.Class('mx-auto w-full max-w-3xl p-4')],
    [
      heading(h, 'Who may change the app'),
      h.p([h.Class('mb-3 text-[12px] text-muted-foreground')], [
        'Administrators prompt changes, approve and undo them, change settings and turn extensions off and on. Members follow along and choose their own settings.',
      ]),
      h.ul(
        [h.Class('divide-y rounded-lg border bg-card px-3')],
        model.members.map(member =>
          h.li(
            [h.Id(`member-${member.id}`), h.Class('flex items-center gap-2 py-2 text-[12.5px]'), h.DataAttribute('role', member.role)],
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

// THE PAGE

const headerTitle = (model: Model) =>
  model.section === 'chat' && model.thread !== null
    ? (conversations(model.runs).find(each => each.thread === model.thread)?.title ?? 'Conversation')
    : SECTION_LABEL[model.section]

/** The open section; only it is rendered. */
const sectionView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  switch (model.section) {
    case 'chat':
      return [
        region(h, {
          id: 'workshop-chat',
          deps: [model.thread, model.runs, model.activity, model.diffs, model.shown, admin(model)],
          render: () => chatTranscript(model, h),
        }),
        region(h, {
          id: 'workshop-form',
          deps: [model.prompt, model.notice, model.thread, model.runs, admin(model), model.members],
          render: () => (admin(model) ? composer(model, h) : membersNote(model, h)),
        }),
      ]
    case 'extensions':
      return [
        h.div(
          [h.Class('min-h-0 flex-1 overflow-y-auto')],
          [
            region(h, {
              id: 'workshop-extensions',
              deps: [model.extensions, model.editing, model.settingsChanges, admin(model), model.inventory, model.pages, model.mySettings],
              render: () => extensionsSection(model, h),
            }),
          ],
        ),
      ]
    case 'changes':
      return [
        h.div(
          [h.Class('min-h-0 flex-1 overflow-y-auto')],
          [region(h, { id: 'workshop-changes', deps: [model.runs, model.diffs, model.shown, admin(model)], render: () => h.div([h.Id('workshop-changes')], [changesSection(model, h)]) })],
        ),
      ]
    case 'customize':
      return [
        h.div(
          [h.Class('min-h-0 flex-1 overflow-y-auto')],
          [region(h, { id: 'workshop-customize', deps: [model.inventory, model.pages, model.extensions, admin(model)], render: () => customizeSection(model, h) })],
        ),
      ]
    case 'people':
      return [
        h.div(
          [h.Class('min-h-0 flex-1 overflow-y-auto')],
          [region(h, { id: 'workshop-members', deps: [model.members, model.shell.me], render: () => peopleSection(model, h) })],
        ),
      ]
  }
}

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `${SECTION_LABEL[model.section]} · Extensions · Linear`,
  body: frame(
    model.shell,
    PATH,
    [
      region(h, {
        id: 'workshop-header',
        deps: [model.section, model.thread, model.notice, model.section === 'chat' ? model.runs : null],
        render: () =>
          h.header(
            [h.Id('workshop-header'), h.Class('flex h-11 shrink-0 items-center gap-2 border-b px-4')],
            [
              h.h1([h.Class('text-[13px] font-semibold')], ['Extensions']),
              Icon.icon('chevron-right', { class: 'size-3.5 text-muted-foreground' }, h),
              h.span([h.Id('workshop-title'), h.Class('max-w-md truncate text-[13px] text-muted-foreground')], [headerTitle(model)]),
              h.p([h.Id('workshop-notice'), h.Class('min-w-0 flex-1 truncate text-right text-[12px] text-muted-foreground'), h.AriaLive('polite'), h.Title(model.notice ?? '')], [
                model.notice ?? '',
              ]),
            ],
          ),
      }),
      h.div(
        [h.Class('flex min-h-0 flex-1')],
        [
          region(h, {
            id: 'workshop-nav',
            deps: [model.section, model.thread, model.runs, model.extensions.length, model.members.length, admin(model)],
            render: () => sectionNav(model, h),
          }),
          h.div([h.Class('flex min-w-0 flex-1 flex-col')], sectionView(model, h)),
        ],
      ),
    ],
    h,
  ),
})

/** The section and conversation of a request; a path the page does not
 *  serve is not found. */
const placeOf = (request: PageRequest) => {
  const place = locate(request.url)
  return place === null ? Effect.fail(new PageNotFound()) : Effect.succeed(place)
}

export const program: Program<Model, Message, ClientMessage, Flags, Workspace | Contributions | Changes | Extensions | PageHost> = {
  name: 'workshop',
  Model,
  ClientMessage,
  flags: request =>
    Effect.gen(function* () {
      const shell = yield* loadShell(request)
      const place = yield* placeOf(request)
      const runs = yield* Changes.use(changes => changes.current)
      const extensions = yield* Extensions.use(extensions => extensions.current)
      const settingsChanges = yield* Extensions.use(extensions => extensions.currentSettingsChanges)
      const members = (yield* Workspace.use(workspace => workspace.current)).members
      const inventory = yield* Contributions.use(contributions => contributions.inventory)
      const pages = yield* PageHost.use(host => host.pages)
      const mySettings = yield* Extensions.use(extensions => Stream.runHead(extensions.memberSettings(shell.me.id))).pipe(
        Effect.map(head => (head._tag === 'Some' ? head.value : [])),
      )
      return {
        shell,
        section: place.section,
        thread: threadFor(runs, place.thread),
        runs,
        extensions,
        settingsChanges,
        members,
        inventory,
        pages,
        mySettings,
      }
    }),
  init,
  update,
  view,
  subscriptions,
  clientCommands: {
    'Workshop.ReplaceUrl': ({ url }) => (typeof url === 'string' ? { replaceUrl: url } : undefined),
    'Workshop.PushUrl': ({ url }) => (typeof url === 'string' ? { pushUrl: url } : undefined),
  },
  // Links between the sections and conversations stay in the session.
  onUrlChange: request => Effect.map(placeOf(request), place => Message.ChangedUrl(place)),
  snapshotDeps: model => [model.section, model.thread, model.prompt, model.editing, model.notice, model.shown],
}
