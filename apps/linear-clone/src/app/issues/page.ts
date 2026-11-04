import { Duration, Effect, Match as M, Option, Schema as S, Stream } from 'effect'
import { Command, Subscription, type Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import * as Navigation from 'foldkit/navigation'

import { PageNotFound, type PageRequest, type Program, keyBindings, memoizeLast, region } from '@hyper-effect/core'

import * as Icon from '@/lib/icon'
import { cn } from '@/lib/utils'
import { button } from '@/ui/button'
import * as Dialog from '@/ui/dialog'
import { kbd } from '@/ui/kbd'
import { input } from '@/ui/input'
import { renderTextarea } from '@/lib/textarea'

import { requireUser } from '../auth'
import {
  BOARD_ORDER,
  GROUP_ORDER,
  Issue,
  IssueChange,
  LABELS,
  Layout,
  Member,
  NewIssue,
  Priority,
  PRIORITIES,
  Query,
  STATUSES,
  Status,
  TEAMS,
  TeamKey,
  compareIssues,
  firstName,
  formatDate,
  hasFilters,
  isClosed,
  labelById,
  matchesQuery,
  priorityLabel,
  queryFromUrl,
  searchForQuery,
  statusLabel,
  teamName,
  validate,
} from '../domain'
import { Shortcut, shortcutBindings } from '../shortcuts/contract'
import { Workspace, type WorkspaceState } from '../store'
import { avatar, labelChip, priorityIcon, statusIcon, teamBadge } from '../view/icons'
import * as Picker from '../view/picker'
import { decodeTeam, patchFor, propertyIcon, propertyItems, valuesOf } from '../view/properties'
import { type NavCounts, VIEWS, hint, sidebar } from '../view/shell'

/* The issue list and board: one program for a team's issues, My issues and
   All issues. Moving between them stays in the session (onUrlChange): the
   sidebar's links change the scope instead of loading a page. Everything a
   user does here is a Message handled on the server:
   - the shared list arrives live through a Subscription on the workspace;
   - filters, search and the layout live in the Model and in the address bar;
   - the keyboard island reports shortcuts (c, j/k, Enter, s/p/a/l, /, Ctrl+K);
   - the picker and the new-issue dialog are part of the Model and the view. */

// MODEL

export const Scope = S.Union([
  S.TaggedStruct('Team', { team: TeamKey }),
  S.TaggedStruct('Mine', {}),
  S.TaggedStruct('All', {}),
])
export type Scope = typeof Scope.Type

export const Draft = S.Struct({
  team: TeamKey,
  title: S.String,
  description: S.String,
  status: Status,
  priority: Priority,
  assigneeId: S.NullOr(S.String),
  labelIds: S.Array(S.String),
  errors: S.Record(S.String, S.String),
  isSaving: S.Boolean,
})
export type Draft = typeof Draft.Type

export const Toast = S.Struct({ text: S.String, href: S.NullOr(S.String), seq: S.Number })
export type Toast = typeof Toast.Type

export const FocusRequest = S.Struct({ selector: S.String, seq: S.Number })

export const Model = S.Struct({
  me: Member,
  scope: Scope,
  query: Query,
  members: S.Array(Member),
  issues: S.Array(Issue),
  selectedId: S.NullOr(S.String),
  collapsed: S.Array(Status),
  picker: S.NullOr(Picker.Picker),
  draft: S.NullOr(Draft),
  focus: S.NullOr(FocusRequest),
  toast: S.NullOr(Toast),
  /** The card being dragged on the board, and the column under it. */
  dragging: S.NullOr(S.String),
  dropTarget: S.NullOr(Status),
  seq: S.Number,
  /** The keyboard shortcuts dialog (`?`), a crease dialog. */
  help: Dialog.Model,
})
export type Model = typeof Model.Type

// MESSAGE

export const PickerTarget = Picker.Picker.fields.target

export const Message = defineMessageUnion({
  ChangedSearch: { search: S.String },
  ClickedLayout: { layout: Layout },
  ClickedCreate: { status: S.NullOr(Status) },
  ClickedOpenPicker: {
    field: Picker.PickerField,
    target: PickerTarget,
    issueId: S.NullOr(S.String),
    anchor: S.NullOr(S.String),
  },
  ChangedPickerQuery: { query: S.String },
  PressedPickerKey: { key: S.String },
  ClickedPickerItem: { value: S.String },
  ClickedClosePicker: {},
  ClickedRemoveFilter: { dimension: S.Literals(['status', 'priority', 'assignee', 'label']) },
  ClickedClearFilters: {},
  ClickedToggleGroup: { status: Status },
  ClickedToggleTheme: {},
  ChangedDraftTitle: { title: S.String },
  ChangedDraftDescription: { description: S.String },
  SubmittedDraft: {},
  ClickedCloseDraft: {},
  ClickedDismissToast: {},
  StartedDrag: { id: S.String },
  EnteredColumn: { status: Status },
  DroppedOnColumn: { status: Status },
  EndedDrag: {},
  PressedShortcut: { shortcut: Shortcut, targetId: S.String },
  /** The page already moved the selection to this row (a local effect). */
  MovedSelection: { elementId: S.String },
  ChangedUrl: { scope: Scope, query: Query },
  GotHelpDialog: { message: Dialog.Message },
  GotWorkspace: { members: S.Array(Member), issues: S.Array(Issue) },
  SucceededCreate: { id: S.String, identifier: S.String },
  FailedCreate: { reason: S.String },
  CompletedChange: {},
  FailedChange: { reason: S.String },
  ExpiredToast: { seq: S.Number },
  CompletedBrowserAction: {},
})
export type Message = typeof Message.Type

/** What a browser may post as it is. Typed text, picker keys and keyboard
 *  shortcuts arrive through the session's handlers; workspace changes and
 *  Command results are server facts. Every one is re-checked in update. */
export const ClientMessage = S.Union([
  Message.ClickedLayout,
  Message.ClickedCreate,
  Message.ClickedOpenPicker,
  Message.ClickedPickerItem,
  Message.ClickedClosePicker,
  Message.ClickedRemoveFilter,
  Message.ClickedClearFilters,
  Message.ClickedToggleGroup,
  Message.ClickedToggleTheme,
  Message.SubmittedDraft,
  Message.ClickedCloseDraft,
  Message.ClickedDismissToast,
  Message.StartedDrag,
  Message.EnteredColumn,
  Message.DroppedOnColumn,
  Message.EndedDrag,
  // The dialog's own bindings; its Command results never come from the page.
  S.TaggedStruct('GotHelpDialog', { message: Dialog.Message.RequestedClose }),
])
export type ClientMessage = typeof ClientMessage.Type

// COMMAND

export const UpdateIssues = Command.define('UpdateIssues', {
  args: { changes: S.Array(IssueChange), actorId: S.String },
  messages: [Message.CompletedChange, Message.FailedChange],
  execute: ({ changes, actorId }) =>
    Workspace.use(workspace => workspace.update(changes, actorId)).pipe(
      Effect.as(Message.CompletedChange()),
      Effect.catchTags({
        IssueNotFound: () => Effect.succeed(Message.FailedChange({ reason: 'That issue was just deleted.' })),
        InvalidChange: ({ reason }) => Effect.succeed(Message.FailedChange({ reason })),
      }),
    ),
})

export const CreateIssue = Command.define('CreateIssue', {
  args: { input: NewIssue, actorId: S.String },
  messages: [Message.SucceededCreate, Message.FailedCreate],
  execute: ({ input, actorId }) =>
    Workspace.use(workspace => workspace.create(input, actorId)).pipe(
      Effect.map(issue => Message.SucceededCreate({ id: issue.id, identifier: issue.identifier })),
      Effect.catchTag('InvalidChange', ({ reason }) => Effect.succeed(Message.FailedCreate({ reason }))),
    ),
})

export const SetTheme = Command.define('SetTheme', {
  args: { memberId: S.String, isDark: S.Boolean },
  messages: [Message.CompletedChange],
  execute: ({ memberId, isDark }) =>
    Workspace.use(workspace => workspace.setTheme(memberId, isDark)).pipe(Effect.as(Message.CompletedChange())),
})

/** Hides a toast after a while (only if it is still the same toast). */
export const ExpireToast = Command.define('ExpireToast', {
  args: { seq: S.Number },
  messages: [Message.ExpiredToast],
  execute: ({ seq }) => Effect.sleep(Duration.seconds(6)).pipe(Effect.as(Message.ExpiredToast({ seq }))),
})

/* Browser effects, forwarded to the page (see `clientCommands`). In a
   browser-run Foldkit app they would run as written. */
export const ReplaceUrl = Command.define('ReplaceUrl', {
  args: { url: S.String },
  messages: [Message.CompletedBrowserAction],
  execute: ({ url }) => Navigation.replaceUrl(url).pipe(Effect.as(Message.CompletedBrowserAction())),
})
export const LoadUrl = Command.define('LoadUrl', {
  args: { url: S.String },
  messages: [Message.CompletedBrowserAction],
  execute: ({ url }) => Navigation.load(url).pipe(Effect.as(Message.CompletedBrowserAction())),
})
/** Moves focus after the next morph: forwarded as a focus action (see
 *  `clientCommands`). The page asks for focus by setting `model.focus`;
 *  `update` turns each new request into this Command. */
export const FocusElement = Command.define('FocusElement', {
  args: { selector: S.String },
  messages: [Message.CompletedBrowserAction],
  execute: () => Effect.succeed(Message.CompletedBrowserAction()),
})

export const ScrollIntoView = Command.define('ScrollIntoView', {
  args: { selector: S.String },
  messages: [Message.CompletedBrowserAction],
  execute: () => Effect.succeed(Message.CompletedBrowserAction()),
})

// INIT

export type Flags = Readonly<{
  me: Member
  scope: Scope
  query: Query
  members: ReadonlyArray<Member>
  issues: ReadonlyArray<Issue>
  /** `?new=1`: open the new-issue dialog at once (the `c` key on other pages). */
  isCreating: boolean
}>

const emptyDraft = (model: Pick<Model, 'scope' | 'me'>, status: Status | null): Draft => ({
  team: model.scope._tag === 'Team' ? model.scope.team : 'ENG',
  title: '',
  description: '',
  status: status ?? 'todo',
  priority: 0,
  assigneeId: model.scope._tag === 'Mine' ? model.me.id : null,
  labelIds: [],
  errors: {},
  isSaving: false,
})

export const init = (flags: Flags): Update.Return<Model, Message, Workspace> => {
  const model: Model = {
    me: flags.me,
    scope: flags.scope,
    query: flags.query,
    members: flags.members,
    issues: flags.issues,
    selectedId: null,
    collapsed: [],
    picker: null,
    draft: null,
    focus: null,
    toast: null,
    dragging: null,
    dropTarget: null,
    seq: 0,
    help: Dialog.init({ id: 'shortcuts-help' }),
  }
  return flags.isCreating ? openDraft(model, null) : { model }
}

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Workspace>

export const basePath = (scope: Scope): string =>
  scope._tag === 'Team' ? `/team/${scope.team}` : scope._tag === 'Mine' ? '/my-issues' : '/issues'

const inScope = (model: Pick<Model, 'scope' | 'me'>) => (issue: Issue): boolean =>
  model.scope._tag === 'Team'
    ? issue.team === model.scope.team
    : model.scope._tag === 'Mine'
      ? issue.assigneeId === model.me.id
      : true

export const visibleIssues = (model: Pick<Model, 'scope' | 'me' | 'issues' | 'query'>): ReadonlyArray<Issue> =>
  model.issues.filter(issue => inScope(model)(issue) && matchesQuery(issue, model.query))

export type Group = Readonly<{ status: Status; issues: ReadonlyArray<Issue> }>

/** Issues by status, in Linear's group order (list) or column order (board). */
export const groupsOf = (issues: ReadonlyArray<Issue>, layout: Layout): ReadonlyArray<Group> =>
  (layout === 'board' ? BOARD_ORDER : GROUP_ORDER).map(status => ({
    status,
    issues: issues.filter(issue => issue.status === status).slice().sort(compareIssues),
  }))

/** The issues j/k walks through, in screen order. */
export const navigationOrder = (model: Model): ReadonlyArray<Issue> =>
  groupsOf(visibleIssues(model), model.query.layout)
    .filter(group => model.query.layout === 'board' || !model.collapsed.includes(group.status))
    .flatMap(group => group.issues)

const withSeq = (model: Model): Model => ({ ...model, seq: model.seq + 1 })

/** Asks the keyboard island to focus an element after the next morph. */
const focusOn = (model: Model, selector: string): Model => {
  const next = withSeq(model)
  return { ...next, focus: { selector, seq: next.seq } }
}

const withQuery = (model: Model, query: Query): UpdateReturn => ({
  model: { ...model, query },
  commands: [ReplaceUrl({ url: `${basePath(model.scope)}${searchForQuery(query)}` })],
})

const openDraft = (model: Model, status: Status | null): UpdateReturn => ({
  model: focusOn({ ...model, picker: null, draft: emptyDraft(model, status) }, '#draft-title'),
})

const openPicker = (model: Model, opened: Picker.Picker): UpdateReturn => {
  const picker = Picker.isMultiSelect(opened.field) ? opened : { ...opened, active: Picker.checkedIndex(pickerItems(model, opened)) }
  return { model: focusOn({ ...model, picker }, `#${Picker.PICKER_INPUT_ID}`) }
}

const showToast = (model: Model, text: string, href: string | null): UpdateReturn => {
  const next = withSeq(model)
  return { model: { ...next, toast: { text, href, seq: next.seq } }, commands: [ExpireToast({ seq: next.seq })] }
}

const targetIssues = (model: Model, picker: Picker.Picker): ReadonlyArray<Issue> =>
  model.issues.filter(issue => picker.issueIds.includes(issue.id))

/** Every item the open picker offers (unfiltered). */
export const pickerItems = (model: Model, picker: Picker.Picker): ReadonlyArray<Picker.PickerItem> => {
  if (picker.target === 'filter') return filterItems(model)
  if (picker.target === 'palette' && picker.field === 'command') return commandItems(model)
  const values =
    picker.target === 'draft' && model.draft !== null
      ? {
          status: model.draft.status,
          priority: model.draft.priority,
          assigneeId: model.draft.assigneeId,
          labelIds: model.draft.labelIds,
          team: model.draft.team,
        }
      : valuesOf(targetIssues(model, picker))
  return propertyItems(picker.field, values, model.members, model.me)
}

const filterItems = (model: Model): ReadonlyArray<Picker.PickerItem> => [
  ...STATUSES.map(status => ({ value: `status:${status}`, label: statusLabel[status], group: 'Status', isChecked: model.query.status.includes(status) })),
  ...PRIORITIES.map(priority => ({
    value: `priority:${priority}`,
    label: priorityLabel[priority],
    group: 'Priority',
    isChecked: model.query.priority.includes(priority),
  })),
  { value: 'assignee:none', label: 'No assignee', group: 'Assignee', isChecked: model.query.assignee.includes('none') },
  ...model.members.map(member => ({
    value: `assignee:${member.id}`,
    label: member.name,
    group: 'Assignee',
    isChecked: model.query.assignee.includes(member.id),
  })),
  ...LABELS.map(label => ({ value: `label:${label.id}`, label: label.name, group: 'Label', isChecked: model.query.label.includes(label.id) })),
]

const commandItems = (model: Model): ReadonlyArray<Picker.PickerItem> => {
  const selected = model.issues.find(issue => issue.id === model.selectedId)
  return [
    { value: 'create', label: 'Create new issue', group: 'Issues', shortcut: 'C' },
    ...(selected === undefined
      ? []
      : [
          { value: 'status', label: `Change status of ${selected.identifier}…`, group: selected.identifier, shortcut: 'S' },
          { value: 'priority', label: `Set priority of ${selected.identifier}…`, group: selected.identifier, shortcut: 'P' },
          { value: 'assignee', label: `Assign ${selected.identifier} to…`, group: selected.identifier, shortcut: 'A' },
          { value: 'labels', label: `Change labels of ${selected.identifier}…`, group: selected.identifier, shortcut: 'L' },
          { value: 'open', label: `Open ${selected.identifier}`, group: selected.identifier, keywords: selected.title },
        ]),
    { value: 'filter', label: 'Filter…', group: 'View', keywords: 'status priority label assignee' },
    {
      value: 'layout',
      label: model.query.layout === 'board' ? 'Switch to list layout' : 'Switch to board layout',
      group: 'View',
      shortcut: 'Ctrl B',
    },
    ...(hasFilters(model.query) ? [{ value: 'clear', label: 'Clear filters', group: 'View' }] : []),
    { value: 'theme', label: model.me.isDark ? 'Switch to light theme' : 'Switch to dark theme', group: 'View' },
    { value: 'go:/my-issues', label: 'Go to My issues', group: 'Navigation', shortcut: 'G M' },
    { value: 'go:/issues', label: 'Go to All issues', group: 'Navigation' },
    ...TEAMS.map(team => ({ value: `go:/team/${team.key}`, label: `Go to ${team.name}`, group: 'Navigation', shortcut: `G ${team.key.charAt(0)}` })),
    ...VIEWS.map(view => ({ value: `go:${view.href}`, label: `Open view: ${view.label}`, group: 'Navigation' })),
    ...model.issues
      .filter(inScope(model))
      .slice()
      .sort(compareIssues)
      .map(issue => ({ value: `issue:${issue.identifier}`, label: `${issue.identifier} ${issue.title}`, group: 'Issues in this view', keywords: statusLabel[issue.status] })),
  ]
}

const toggle = <A>(values: ReadonlyArray<A>, value: A): ReadonlyArray<A> =>
  values.includes(value) ? values.filter(candidate => candidate !== value) : [...values, value]

const decodeStatus = S.decodeUnknownOption(Status)
const decodePriority = S.decodeUnknownOption(Priority)

const toggleFilter = (model: Model, value: string): UpdateReturn => {
  const [dimension, raw = ''] = value.split(':')
  const query = model.query
  const next: Query | undefined =
    dimension === 'status'
      ? Option.match(decodeStatus(raw), { onNone: () => undefined, onSome: status => ({ ...query, status: toggle(query.status, status) }) })
      : dimension === 'priority'
        ? Option.match(decodePriority(Number(raw)), {
            onNone: () => undefined,
            onSome: priority => ({ ...query, priority: toggle(query.priority, priority) }),
          })
        : dimension === 'assignee' && (raw === 'none' || model.members.some(member => member.id === raw))
          ? { ...query, assignee: toggle(query.assignee, raw) }
          : dimension === 'label' && labelById(raw) !== undefined
            ? { ...query, label: toggle(query.label, raw) }
            : undefined
  return next === undefined ? { model } : withQuery(model, next)
}

/** A choice in a property picker. */
const chooseProperty = (model: Model, picker: Picker.Picker, value: string): UpdateReturn => {
  if (picker.target === 'draft') {
    const draft = model.draft
    if (draft === null) return { model: { ...model, picker: null } }
    const close = (next: Draft): UpdateReturn => ({ model: focusOn({ ...model, draft: next, picker: null }, '#draft-title') })
    switch (picker.field) {
      case 'status':
        return Option.match(decodeStatus(value), { onNone: () => ({ model }), onSome: status => close({ ...draft, status }) })
      case 'priority':
        return Option.match(decodePriority(Number(value)), { onNone: () => ({ model }), onSome: priority => close({ ...draft, priority }) })
      case 'assignee':
        return value === 'none'
          ? close({ ...draft, assigneeId: null })
          : model.members.some(member => member.id === value)
            ? close({ ...draft, assigneeId: value })
            : { model }
      case 'labels':
        return labelById(value) === undefined ? { model } : { model: { ...model, draft: { ...draft, labelIds: toggle(draft.labelIds, value) } } }
      case 'team':
        return Option.match(decodeTeam(value), { onNone: () => ({ model }), onSome: team => close({ ...draft, team }) })
      default:
        return { model }
    }
  }
  const issues = targetIssues(model, picker)
  if (issues.length === 0) return { model: { ...model, picker: null } }
  return Option.match(patchFor(picker.field, value, issues, model.members), {
    onNone: () => ({ model }),
    onSome: changes => ({
      // Labels stay open for several toggles, like Linear's.
      model: Picker.isMultiSelect(picker.field) ? model : { ...model, picker: null },
      commands: [UpdateIssues({ changes, actorId: model.me.id })],
    }),
  })
}

const runCommand = (model: Model, value: string): UpdateReturn => {
  const closed = { ...model, picker: null }
  const selected = model.issues.find(issue => issue.id === model.selectedId)
  if (value.startsWith('go:')) {
    const href = value.slice(3)
    const isKnown = href === '/my-issues' || href === '/issues' || TEAMS.some(team => href === `/team/${team.key}`) || VIEWS.some(view => view.href === href)
    return isKnown ? { model: closed, commands: [LoadUrl({ url: href })] } : { model }
  }
  if (value.startsWith('issue:')) {
    const issue = model.issues.find(candidate => candidate.identifier === value.slice(6))
    return issue === undefined ? { model } : { model: closed, commands: [LoadUrl({ url: `/issue/${issue.identifier}` })] }
  }
  switch (value) {
    case 'create':
      return openDraft(closed, null)
    case 'status':
    case 'priority':
    case 'assignee':
    case 'labels':
      return selected === undefined ? { model: closed } : openPicker(closed, Picker.open(value, 'issues', [selected.id], null))
    case 'open':
      return selected === undefined ? { model: closed } : { model: closed, commands: [LoadUrl({ url: `/issue/${selected.identifier}` })] }
    case 'filter':
      return openPicker(closed, Picker.open('filter', 'filter', [], null))
    case 'layout':
      return withQuery(closed, { ...model.query, layout: model.query.layout === 'board' ? 'list' : 'board' })
    case 'clear':
      return withQuery(closed, { ...model.query, status: [], priority: [], assignee: [], label: [] })
    case 'theme':
      return { model: closed, commands: [SetTheme({ memberId: model.me.id, isDark: !model.me.isDark })] }
    default:
      return { model }
  }
}

const choose = (model: Model, value: string): UpdateReturn => {
  const picker = model.picker
  if (picker === null) return { model }
  // Only values the picker offers are accepted (the browser may post anything).
  if (!pickerItems(model, picker).some(item => item.value === value)) return { model }
  switch (picker.target) {
    case 'filter':
      return toggleFilter(model, value)
    case 'palette':
      return runCommand(model, value)
    default:
      return chooseProperty(model, picker, value)
  }
}

const moveSelection = (model: Model, delta: 1 | -1): UpdateReturn => {
  const order = navigationOrder(model)
  if (order.length === 0) return { model }
  const index = order.findIndex(issue => issue.id === model.selectedId)
  const next = order[index === -1 ? (delta === 1 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, index + delta))]
  return next === undefined
    ? { model }
    : { model: { ...model, selectedId: next.id }, commands: [ScrollIntoView({ selector: `#row-${next.identifier}` })] }
}

const selectedIssue = (model: Model): Issue | undefined => model.issues.find(issue => issue.id === model.selectedId)

const onShortcut = (model: Model, shortcut: Shortcut, targetId: string): UpdateReturn => {
  const selected = selectedIssue(model)
  const property = (field: Picker.PickerField): UpdateReturn =>
    selected === undefined || model.picker !== null || model.draft !== null
      ? { model }
      : openPicker(model, Picker.open(field, 'issues', [selected.id], null))
  switch (shortcut) {
    case 'create':
      return model.draft === null ? openDraft(model, null) : { model }
    case 'down':
      return moveSelection(model, 1)
    case 'up':
      return moveSelection(model, -1)
    case 'open':
      return selected === undefined ? { model } : { model, commands: [LoadUrl({ url: `/issue/${selected.identifier}` })] }
    case 'status':
    case 'priority':
    case 'assignee':
    case 'labels':
      return property(shortcut)
    case 'search':
      return { model: focusOn(model, '#search') }
    case 'palette':
      return model.picker?.field === 'command'
        ? { model: { ...model, picker: null } }
        : openPicker({ ...model, draft: model.draft }, Picker.open('command', 'palette', [], null))
    case 'escape':
      return model.help.isOpen
        ? withHelp(model, Dialog.close(model.help))
        : model.picker !== null
        ? { model: { ...model, picker: null } }
        : model.draft !== null
          ? { model: { ...model, draft: null } }
          : { model: { ...model, selectedId: null } }
    case 'submit':
      return model.draft !== null && targetId.startsWith('draft-') ? submitDraft(model) : { model }
    case 'goMyIssues':
      return { model, commands: [LoadUrl({ url: '/my-issues' })] }
    case 'goEngineering':
      return { model, commands: [LoadUrl({ url: '/team/ENG' })] }
    case 'goDesign':
      return { model, commands: [LoadUrl({ url: '/team/DES' })] }
    case 'toggleLayout':
      return withQuery(model, { ...model.query, layout: model.query.layout === 'board' ? 'list' : 'board' })
    case 'help':
      return withHelp(model, Dialog.open(model.help))
  }
}

const withHelp = (model: Model, helpUpdate: ReturnType<typeof Dialog.update>): UpdateReturn => ({
  model: { ...model, help: helpUpdate.model },
  commands: Command.mapMessages(helpUpdate.commands, message => Message.GotHelpDialog({ message })),
})

const submitDraft = (model: Model): UpdateReturn => {
  const draft = model.draft
  if (draft === null || draft.isSaving) return { model }
  const result = validate(NewIssue, {
    team: draft.team,
    title: draft.title.trim(),
    description: draft.description.trim(),
    status: draft.status,
    priority: draft.priority,
    assigneeId: draft.assigneeId,
    labelIds: draft.labelIds,
  })
  if (!result.ok) return { model: focusOn({ ...model, draft: { ...draft, errors: result.errors } }, '#draft-title') }
  return {
    model: { ...model, draft: { ...draft, errors: {}, isSaving: true } },
    commands: [CreateIssue({ input: result.value, actorId: model.me.id })],
  }
}

/** Every new focus request (`focusOn`) becomes a forwarded focus. */
export const update = (model: Model, message: Message): UpdateReturn => {
  const result = updateModel(model, message)
  const focus = result.model.focus
  return focus !== null && focus.seq !== model.focus?.seq
    ? { ...result, commands: [...(result.commands ?? []), FocusElement({ selector: focus.selector })] }
    : result
}

/** The page's update without the focus wrapper, for Story tests. */
export const updateModel = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ChangedSearch: ({ search }) => withQuery(model, { ...model.query, search: search.slice(0, 100) }),
      ClickedLayout: ({ layout }) => withQuery(model, { ...model.query, layout }),
      ClickedCreate: ({ status }) => openDraft(model, status),
      ClickedOpenPicker: ({ field, target, issueId, anchor }) => {
        if (target === 'issues') {
          const issue = model.issues.find(candidate => candidate.id === issueId)
          return issue === undefined || field === 'filter' || field === 'command' || field === 'team'
            ? { model }
            : openPicker({ ...model, selectedId: issue.id }, Picker.open(field, 'issues', [issue.id], anchor))
        }
        if (target === 'draft') {
          return model.draft === null || field === 'filter' || field === 'command' ? { model } : openPicker(model, Picker.open(field, 'draft', [], anchor))
        }
        return openPicker(model, Picker.open(target === 'filter' ? 'filter' : 'command', target, [], anchor))
      },
      ChangedPickerQuery: ({ query }) =>
        model.picker === null ? { model } : { model: { ...model, picker: { ...model.picker, query: query.slice(0, 100), active: 0 } } },
      PressedPickerKey: ({ key }) => {
        const picker = model.picker
        if (picker === null) return { model }
        const action = Picker.keyAction(picker, pickerItems(model, picker), key)
        switch (action._tag) {
          case 'move':
            return { model: { ...model, picker: { ...picker, active: action.active } }, commands: [ScrollIntoView({ selector: `#picker-item-${action.active}` })] }
          case 'choose':
            return choose(model, action.value)
          case 'close':
            return { model: model.draft !== null ? focusOn({ ...model, picker: null }, '#draft-title') : { ...model, picker: null } }
          case 'none':
            return { model }
        }
      },
      ClickedPickerItem: ({ value }) => choose(model, value),
      ClickedClosePicker: () => ({ model: { ...model, picker: null } }),
      ClickedRemoveFilter: ({ dimension }) => withQuery(model, { ...model.query, [dimension]: [] }),
      ClickedClearFilters: () => withQuery(model, { ...model.query, status: [], priority: [], assignee: [], label: [] }),
      ClickedToggleGroup: ({ status }) => ({ model: { ...model, collapsed: toggle(model.collapsed, status) } }),
      ClickedToggleTheme: () => ({ model, commands: [SetTheme({ memberId: model.me.id, isDark: !model.me.isDark })] }),
      ChangedDraftTitle: ({ title }) =>
        model.draft === null ? { model } : { model: { ...model, draft: { ...model.draft, title, errors: { ...model.draft.errors, title: '' } } } },
      ChangedDraftDescription: ({ description }) =>
        model.draft === null ? { model } : { model: { ...model, draft: { ...model.draft, description } } },
      SubmittedDraft: () => submitDraft(model),
      ClickedCloseDraft: () => ({ model: { ...model, draft: null, picker: null } }),
      ClickedDismissToast: () => ({ model: { ...model, toast: null } }),
      StartedDrag: ({ id }) =>
        model.issues.some(issue => issue.id === id) ? { model: { ...model, dragging: id, dropTarget: null, picker: null } } : { model },
      EnteredColumn: ({ status }) => (model.dragging === null ? { model } : { model: { ...model, dropTarget: status } }),
      DroppedOnColumn: ({ status }) => {
        const issue = model.issues.find(candidate => candidate.id === model.dragging)
        const done = { ...model, dragging: null, dropTarget: null }
        return issue === undefined || issue.status === status
          ? { model: done }
          : { model: { ...done, selectedId: issue.id }, commands: [UpdateIssues({ changes: [{ id: issue.id, patch: { status } }], actorId: model.me.id })] }
      },
      EndedDrag: () => ({ model: { ...model, dragging: null, dropTarget: null } }),
      PressedShortcut: ({ shortcut, targetId }) => onShortcut(model, shortcut, targetId),
      GotHelpDialog: ({ message }) => withHelp(model, Dialog.update(model.help, message)),
      MovedSelection: ({ elementId }) => {
        const issue = navigationOrder(model).find(candidate => `row-${candidate.identifier}` === elementId)
        return { model: issue === undefined ? model : { ...model, selectedId: issue.id } }
      },
      ChangedUrl: ({ scope, query }) => ({
        model: { ...model, scope, query, selectedId: null, picker: null, focus: null },
      }),
      GotWorkspace: ({ members, issues }) => {
        const me = members.find(member => member.id === model.me.id) ?? model.me
        // A selection or picker on an issue someone deleted goes away.
        const selectedId = issues.some(issue => issue.id === model.selectedId) ? model.selectedId : null
        const picker =
          model.picker !== null && model.picker.target === 'issues' && !model.picker.issueIds.every(id => issues.some(issue => issue.id === id))
            ? null
            : model.picker
        return { model: { ...model, me, members, issues, selectedId, picker } }
      },
      SucceededCreate: ({ id, identifier }) =>
        showToast({ ...model, draft: null, selectedId: id }, `Created ${identifier}`, `/issue/${identifier}`),
      FailedCreate: ({ reason }) =>
        model.draft === null ? { model } : { model: { ...model, draft: { ...model.draft, isSaving: false, errors: { '': reason } } } },
      CompletedChange: () => ({ model }),
      FailedChange: ({ reason }) => showToast(model, reason, null),
      ExpiredToast: ({ seq }) => (model.toast?.seq === seq ? { model: { ...model, toast: null } } : { model }),
      CompletedBrowserAction: () => ({ model }),
    }),
  )

// SUBSCRIPTION

// The same Message for every session per workspace change (built once).
const gotWorkspace = memoizeLast((state: Pick<WorkspaceState, 'members' | 'issues'>) =>
  Message.GotWorkspace({ members: state.members, issues: state.issues }),
)

export const subscriptions = Subscription.make<Model, Message, Workspace>()(entry => ({
  workspace: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Stream.unwrap(
          Workspace.use(workspace =>
            Effect.succeed(
              workspace.changes.pipe(
                // Comments and activity do not change the list.
                Stream.changesWith((a, b) => a.members === b.members && a.issues === b.issues),
                Stream.map(state => gotWorkspace(sharedSlice(state))),
              ),
            ),
          ),
        ),
    },
  ),
}))

// One object per state, so `memoizeLast` sees the same input for every session.
const sharedSlice = memoizeLast((state: WorkspaceState) => ({ members: state.members, issues: state.issues }))

// VIEW

export const counts = (model: Pick<Model, 'issues' | 'me'>): NavCounts => ({
  my: model.issues.filter(issue => issue.assigneeId === model.me.id && !isClosed(issue.status)).length,
  ENG: model.issues.filter(issue => issue.team === 'ENG' && !isClosed(issue.status)).length,
  DES: model.issues.filter(issue => issue.team === 'DES' && !isClosed(issue.status)).length,
})

const scopeTitle = (scope: Scope): string =>
  scope._tag === 'Team' ? teamName(scope.team) : scope._tag === 'Mine' ? 'My issues' : 'All issues'

const activeHref = (model: Model): string => {
  const base = basePath(model.scope)
  const search = searchForQuery(model.query)
  const view = VIEWS.find(candidate => candidate.href === `${base}${search}`)
  if (view !== undefined) return view.href
  return model.query.layout === 'board' && model.scope._tag === 'Team' ? `${base}?view=board` : base
}

const anchorName = (key: string) => `--anchor-${key.replace(/[^a-zA-Z0-9-]/g, '-')}`

const openPickerButton = (
  h: HtmlBuilder<Message>,
  config: Readonly<{
    field: Picker.PickerField
    target: Picker.Picker['target']
    issueId: string | null
    anchorKey: string
    label: string
    class: string
    children: ReadonlyArray<Html | string>
    id?: string
  }>,
): Html => {
  const anchor = anchorName(config.anchorKey)
  return h.button(
    [
      h.Type('button'),
      ...(config.id === undefined ? [] : [h.Id(config.id)]),
      h.AriaLabel(config.label),
      h.Title(config.label),
      h.AriaHasPopup('dialog'),
      h.Class(config.class),
      h.Style({ anchorName: anchor }),
      h.OnClick(Message.ClickedOpenPicker({ field: config.field, target: config.target, issueId: config.issueId, anchor })),
    ],
    [...config.children],
  )
}

const header = (model: Model, h: HtmlBuilder<Message>): Html => {
  const scope = model.scope
  const title = scopeTitle(scope)
  const view = VIEWS.find(candidate => candidate.href === activeHref(model))
  return h.header(
    [h.Id('header'), h.Class('flex h-12 shrink-0 items-center gap-2 border-b px-4')],
    [
      ...(scope._tag === 'Team'
        ? [teamBadge(TEAMS.find(team => team.key === scope.team)?.color ?? 'bg-slate-500', scope.team.charAt(0), h)]
        : []),
      h.h1([h.Class('text-[13px] font-semibold')], [title]),
      ...(view === undefined
        ? []
        : [Icon.icon('chevron-right', { class: 'size-3.5 text-muted-foreground' }, h), h.span([h.Class('text-[13px] font-medium')], [view.label])]),
      h.div(
        [h.Class('ml-3 flex items-center rounded-md border p-0.5'), h.Role('group'), h.AriaLabel('Layout')],
        (['list', 'board'] as const).map(layout =>
          h.button(
            [
              h.Type('button'),
              h.Id(`layout-${layout}`),
              h.AriaPressed(model.query.layout === layout ? 'true' : 'false'),
              h.AriaLabel(layout === 'list' ? 'List layout' : 'Board layout'),
              h.Title(layout === 'list' ? 'List' : 'Board'),
              h.Class(
                cn(
                  'flex h-6 items-center gap-1.5 rounded-[5px] px-2 text-[12px] font-medium text-muted-foreground hover:text-foreground',
                  model.query.layout === layout && 'bg-accent text-foreground shadow-xs',
                ),
              ),
              h.OnClick(Message.ClickedLayout({ layout })),
            ],
            [Icon.icon(layout === 'list' ? 'list' : 'columns-3', { class: 'size-3.5' }, h), layout === 'list' ? 'List' : 'Board'],
          ),
        ),
      ),
      h.div([h.Class('flex-1')], []),
      h.div(
        [h.Class('relative w-56')],
        [
          h.span([h.Class('pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground')], [Icon.search({ class: 'size-3.5' }, h)]),
          input(
            {
              id: 'search',
              value: model.query.search,
              placeholder: 'Search issues…',
              ariaLabel: 'Search issues',
              autocomplete: 'off',
              type: 'search',
              onInput: search => Message.ChangedSearch({ search }),
              class: 'h-7 pl-7 text-[13px] md:text-[13px] shadow-none',
            },
            h,
          ),
          h.span([h.Class('pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2')], [hint(h, '/')]),
        ],
      ),
      button(
        {
          id: 'new-issue',
          children: ['New issue'],
          size: 'xs',
          class: 'h-7 px-2.5 text-[12px]',
          leadingIcon: Icon.plus({ class: 'size-3.5' }, h),
          onClick: Message.ClickedCreate({ status: null }),
        },
        h,
      ),
    ],
  )
}

const filterBar = (model: Model, h: HtmlBuilder<Message>): Html => {
  const query = model.query
  const chip = (dimension: 'status' | 'priority' | 'assignee' | 'label', label: string, values: ReadonlyArray<string>): Html =>
    h.div(
      [h.Class('flex h-6 items-center overflow-hidden rounded-md border text-[12px]'), h.DataAttribute('filter', dimension)],
      [
        h.span([h.Class('px-2 text-muted-foreground')], [label]),
        h.span([h.Class('border-l px-2 text-muted-foreground')], [values.length > 1 ? 'is any of' : 'is']),
        h.span([h.Class('max-w-56 truncate border-l px-2 font-medium')], [values.join(', ')]),
        h.button(
          [
            h.Type('button'),
            h.AriaLabel(`Remove ${label} filter`),
            h.Class('flex h-full items-center border-l px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground'),
            h.OnClick(Message.ClickedRemoveFilter({ dimension })),
          ],
          [Icon.x({ class: 'size-3' }, h)],
        ),
      ],
    )
  const memberName = (id: string) => (id === 'none' ? 'No assignee' : firstName(model.members.find(member => member.id === id)?.name ?? id))
  return h.div(
    [h.Id('filter-bar'), h.Class('flex min-h-10 shrink-0 flex-wrap items-center gap-1.5 border-b px-4 py-1.5')],
    [
      openPickerButton(h, {
        id: 'filter-button',
        field: 'filter',
        target: 'filter',
        issueId: null,
        anchorKey: 'filter',
        label: 'Filter',
        class: 'flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground',
        children: [Icon.icon('list-filter', { class: 'size-3.5' }, h), 'Filter'],
      }),
      ...(query.status.length === 0 ? [] : [chip('status', 'Status', query.status.map(status => statusLabel[status]))]),
      ...(query.priority.length === 0 ? [] : [chip('priority', 'Priority', query.priority.map(priority => priorityLabel[priority]))]),
      ...(query.assignee.length === 0 ? [] : [chip('assignee', 'Assignee', query.assignee.map(memberName))]),
      ...(query.label.length === 0 ? [] : [chip('label', 'Label', query.label.map(id => labelById(id)?.name ?? id))]),
      ...(hasFilters(query)
        ? [
            h.button(
              [
                h.Type('button'),
                h.Class('h-6 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground'),
                h.OnClick(Message.ClickedClearFilters()),
              ],
              ['Clear'],
            ),
          ]
        : []),
    ],
  )
}

const memberOf = (members: ReadonlyArray<Member>, id: string | null): Member | undefined =>
  id === null ? undefined : members.find(member => member.id === id)

/** One list row. Shared across sessions: it reads only its deps. */
const issueRow = (issue: Issue, assignee: Member | undefined, isSelected: boolean, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Id(`row-${issue.identifier}`),
      h.DataAttribute('selected', String(isSelected)),
      h.DataAttribute('status', issue.status),
      h.Class(
        cn(
          'group relative flex h-[38px] items-center gap-2 border-b border-border/60 pr-4 pl-3 text-[13px] transition-colors hover:bg-accent/60',
          // Styled from data-selected, which the page moves before the server answers.
          'data-[selected=true]:bg-accent data-[selected=true]:before:absolute data-[selected=true]:before:inset-y-0 data-[selected=true]:before:left-0 data-[selected=true]:before:w-0.5 data-[selected=true]:before:bg-primary',
        ),
      ),
    ],
    [
      // The whole row opens the issue; the property buttons sit above the link.
      h.a([h.Href(`/issue/${issue.identifier}`), h.Class('absolute inset-0'), h.AriaLabel(`${issue.identifier} ${issue.title}`)], []),
      openPickerButton(h, {
        field: 'priority',
        target: 'issues',
        issueId: issue.id,
        anchorKey: `priority-${issue.identifier}`,
        label: `Priority: ${priorityLabel[issue.priority]}`,
        class: 'relative z-10 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent',
        children: [priorityIcon(issue.priority, h)],
      }),
      h.span([h.Class('w-[52px] shrink-0 text-[12px] tabular-nums text-muted-foreground')], [issue.identifier]),
      openPickerButton(h, {
        field: 'status',
        target: 'issues',
        issueId: issue.id,
        anchorKey: `status-${issue.identifier}`,
        label: `Status: ${statusLabel[issue.status]}`,
        class: 'relative z-10 flex size-6 shrink-0 items-center justify-center rounded hover:bg-accent',
        children: [statusIcon(issue.status, h)],
      }),
      h.span([h.Class(cn('min-w-0 flex-1 truncate font-medium', isClosed(issue.status) && 'text-muted-foreground'))], [issue.title]),
      h.span([h.Class('hidden shrink-0 items-center gap-1 md:flex')], issue.labelIds.map(id => labelChip(id, h))),
      h.span([h.Class('w-12 shrink-0 text-right text-[12px] text-muted-foreground')], [formatDate(issue.createdAt)]),
      openPickerButton(h, {
        field: 'assignee',
        target: 'issues',
        issueId: issue.id,
        anchorKey: `assignee-${issue.identifier}`,
        label: assignee === undefined ? 'Assign' : `Assignee: ${assignee.name}`,
        class: 'relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full hover:bg-accent',
        children: [avatar(assignee, h, 'sm')],
      }),
    ],
  )

const groupHeader = (group: Group, isCollapsed: boolean, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class('sticky top-0 z-20 flex h-9 items-center gap-2 border-b bg-muted/70 pr-3 pl-3 backdrop-blur supports-[backdrop-filter]:bg-muted/60'),
      h.DataAttribute('group', group.status),
    ],
    [
      h.button(
        [
          h.Type('button'),
          h.AriaExpanded(!isCollapsed),
          h.AriaLabel(`${statusLabel[group.status]}: ${group.issues.length} issues`),
          h.Class('flex flex-1 items-center gap-2 text-left'),
          h.OnClick(Message.ClickedToggleGroup({ status: group.status })),
        ],
        [
          Icon.icon(isCollapsed ? 'chevron-right' : 'chevron-down', { class: 'size-3 text-muted-foreground' }, h),
          statusIcon(group.status, h),
          h.span([h.Class('text-[13px] font-medium')], [statusLabel[group.status]]),
          h.span([h.Class('text-[13px] text-muted-foreground tabular-nums'), h.DataAttribute('count', '')], [String(group.issues.length)]),
        ],
      ),
      h.button(
        [
          h.Type('button'),
          h.AriaLabel(`New issue in ${statusLabel[group.status]}`),
          h.Title(`New issue in ${statusLabel[group.status]}`),
          h.Class('flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground'),
          h.OnClick(Message.ClickedCreate({ status: group.status })),
        ],
        [Icon.plus({ class: 'size-3.5' }, h)],
      ),
    ],
  )

const emptyState = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center')],
    [
      h.div([h.Class('flex size-10 items-center justify-center rounded-lg border text-muted-foreground')], [Icon.icon('inbox', { class: 'size-5' }, h)]),
      h.p([h.Class('text-[14px] font-medium')], [hasFilters(model.query) || model.query.search !== '' ? 'No issues match' : 'No issues here']),
      h.p(
        [h.Class('max-w-xs text-[13px] text-muted-foreground')],
        [hasFilters(model.query) || model.query.search !== '' ? 'Try removing a filter or changing the search.' : 'Create the first one with C.'],
      ),
    ],
  )

const listView = (model: Model, groups: ReadonlyArray<Group>, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Id('issue-list'), h.Role('list'), h.AriaLabel('Issues'), h.Class('min-h-0 flex-1 overflow-y-auto')],
    groups.every(group => group.issues.length === 0)
      ? [emptyState(model, h)]
      : groups
          .filter(group => group.issues.length > 0)
          .map(group => {
            const isCollapsed = model.collapsed.includes(group.status)
            return h.section(
              [h.Key(group.status), h.Id(`group-${group.status}`), h.AriaLabel(statusLabel[group.status])],
              [
                groupHeader(group, isCollapsed, h),
                ...(isCollapsed
                  ? []
                  : group.issues.map(issue => {
                      const assignee = memberOf(model.members, issue.assigneeId)
                      const isSelected = issue.id === model.selectedId
                      return region(h, {
                        id: `row-${issue.identifier}`,
                        deps: [issue, assignee, isSelected],
                        // The same markup for everyone with these deps: rendered once.
                        shared: true,
                        render: () => issueRow(issue, assignee, isSelected, h),
                      })
                    })),
              ],
            )
          }),
  )

const boardCard = (issue: Issue, assignee: Member | undefined, isSelected: boolean, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Id(`row-${issue.identifier}`),
      // Native drag and drop: two events, both plain Messages (no island).
      h.Draggable(true),
      h.OnDragStart(Message.StartedDrag({ id: issue.id })),
      h.OnDragEnd(Message.EndedDrag()),
      h.DataAttribute('selected', String(isSelected)),
      h.DataAttribute('status', issue.status),
      h.Class(
        cn(
          'group relative grid cursor-grab gap-2 rounded-lg border bg-card p-3 text-[13px] shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-colors hover:border-foreground/20 active:cursor-grabbing',
          isSelected && 'border-primary/60 ring-1 ring-primary/40',
        ),
      ),
    ],
    [
      h.a([h.Href(`/issue/${issue.identifier}`), h.Draggable(false), h.Class('absolute inset-0 rounded-lg'), h.AriaLabel(`${issue.identifier} ${issue.title}`)], []),
      h.div(
        [h.Class('flex items-center justify-between')],
        [
          h.span([h.Class('text-[12px] text-muted-foreground')], [issue.identifier]),
          openPickerButton(h, {
            field: 'assignee',
            target: 'issues',
            issueId: issue.id,
            anchorKey: `assignee-${issue.identifier}`,
            label: assignee === undefined ? 'Assign' : `Assignee: ${assignee.name}`,
            class: 'relative z-10 rounded-full',
            children: [avatar(assignee, h, 'sm')],
          }),
        ],
      ),
      h.div(
        [h.Class('flex items-start gap-2')],
        [
          openPickerButton(h, {
            field: 'status',
            target: 'issues',
            issueId: issue.id,
            anchorKey: `status-${issue.identifier}`,
            label: `Status: ${statusLabel[issue.status]} (move)`,
            class: 'relative z-10 mt-px flex size-[18px] shrink-0 items-center justify-center rounded hover:bg-accent',
            children: [statusIcon(issue.status, h)],
          }),
          h.span([h.Class('line-clamp-2 font-medium leading-snug')], [issue.title]),
        ],
      ),
      h.div(
        [h.Class('flex flex-wrap items-center gap-1')],
        [
          openPickerButton(h, {
            field: 'priority',
            target: 'issues',
            issueId: issue.id,
            anchorKey: `priority-${issue.identifier}`,
            label: `Priority: ${priorityLabel[issue.priority]}`,
            class: 'relative z-10 flex h-5 w-6 items-center justify-center rounded border text-muted-foreground hover:bg-accent',
            children: [priorityIcon(issue.priority, h, 'size-3')],
          }),
          ...issue.labelIds.map(id => labelChip(id, h)),
        ],
      ),
    ],
  )

const boardView = (model: Model, groups: ReadonlyArray<Group>, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Id('issue-list'), h.AriaLabel('Board'), h.Class('flex min-h-0 flex-1 gap-3 overflow-x-auto bg-muted p-3')],
    groups.map(group =>
      h.section(
        [
          h.Key(group.status),
          h.Id(`column-${group.status}`),
          h.AriaLabel(statusLabel[group.status]),
          h.DataAttribute('drop-target', String(model.dropTarget === group.status)),
          h.AllowDrop(),
          h.OnDragEnter(Message.EnteredColumn({ status: group.status })),
          h.OnDrop(Message.DroppedOnColumn({ status: group.status })),
          h.Class(
            cn(
              'flex w-[300px] shrink-0 flex-col rounded-lg transition-colors',
              model.dragging !== null && model.dropTarget === group.status && 'bg-primary/5 ring-1 ring-primary/30',
            ),
          ),
        ],
        [
          h.div(
            [h.Class('flex h-9 shrink-0 items-center gap-2 px-1')],
            [
              statusIcon(group.status, h),
              h.span([h.Class('text-[13px] font-medium')], [statusLabel[group.status]]),
              h.span([h.Class('text-[13px] tabular-nums text-muted-foreground'), h.DataAttribute('count', '')], [String(group.issues.length)]),
              h.div([h.Class('flex-1')], []),
              h.button(
                [
                  h.Type('button'),
                  h.AriaLabel(`New issue in ${statusLabel[group.status]}`),
                  h.Class('flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground'),
                  h.OnClick(Message.ClickedCreate({ status: group.status })),
                ],
                [Icon.plus({ class: 'size-3.5' }, h)],
              ),
            ],
          ),
          h.div(
            [h.Class('flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-4')],
            group.issues.map(issue => {
              const assignee = memberOf(model.members, issue.assigneeId)
              const isSelected = issue.id === model.selectedId
              return region(h, {
                id: `row-${issue.identifier}`,
                deps: ['card', issue, assignee, isSelected],
                shared: true,
                render: () => boardCard(issue, assignee, isSelected, h),
              })
            }),
          ),
        ],
      ),
    ),
  )

const propertyButtonClass =
  'flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px] font-medium text-foreground/80 hover:bg-accent hover:text-foreground'

const draftDialog = (model: Model, draft: Draft, h: HtmlBuilder<Message>): Html => {
  const team = TEAMS.find(candidate => candidate.key === draft.team) ?? TEAMS[0]!
  const assignee = memberOf(model.members, draft.assigneeId)
  const titleError = draft.errors['title'] ?? ''
  const formError = draft.errors[''] ?? draft.errors['description'] ?? ''
  const property = (field: Picker.PickerField, label: string, children: ReadonlyArray<Html | string>) =>
    openPickerButton(h, {
      id: `draft-${field}`,
      field,
      target: 'draft',
      issueId: null,
      anchorKey: `draft-${field}`,
      label,
      class: propertyButtonClass,
      children,
    })
  return h.div(
    [h.Id('new-issue-layer'), h.Class('contents')],
    [
      h.div([h.AriaHidden(true), h.Class('fixed inset-0 z-30 bg-black/30 dark:bg-black/50'), h.OnClick(Message.ClickedCloseDraft())], []),
      h.form(
        [
          h.Id('new-issue-dialog'),
          h.Role('dialog'),
          h.AriaModal(true),
          h.AriaLabel('New issue'),
          h.Class(
            'fixed top-[12vh] left-1/2 z-30 flex w-[min(720px,calc(100vw-32px))] -translate-x-1/2 flex-col rounded-xl border bg-popover text-popover-foreground shadow-[0_16px_70px_rgb(0_0_0/0.2)]',
          ),
          h.OnSubmit(Message.SubmittedDraft()),
        ],
        [
          h.div(
            [h.Class('flex items-center gap-2 px-4 pt-3.5')],
            [
              property('team', `Team: ${team.name}`, [teamBadge(team.color, team.key.charAt(0), h, 'size-4 text-[9px]'), team.key]),
              Icon.icon('chevron-right', { class: 'size-3.5 text-muted-foreground' }, h),
              h.span([h.Class('text-[13px] text-muted-foreground')], ['New issue']),
              h.div([h.Class('flex-1')], []),
              h.button(
                [
                  h.Type('button'),
                  h.AriaLabel('Close'),
                  h.Class('flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground'),
                  h.OnClick(Message.ClickedCloseDraft()),
                ],
                [Icon.x({ class: 'size-4' }, h)],
              ),
            ],
          ),
          h.div(
            [h.Class('grid gap-1 px-4 pt-3')],
            [
              input(
                {
                  id: 'draft-title',
                  value: draft.title,
                  placeholder: 'Issue title',
                  ariaLabel: 'Issue title',
                  autocomplete: 'off',
                  isInvalid: titleError !== '',
                  onInput: title => Message.ChangedDraftTitle({ title }),
                  class: 'h-9 border-0 px-0 text-[18px] font-semibold shadow-none focus-visible:ring-0 md:text-[18px] dark:bg-transparent aria-invalid:ring-0',
                },
                h,
              ),
              ...(titleError === '' ? [] : [h.p([h.Id('draft-title-error'), h.Class('text-[12px] text-destructive')], [titleError])]),
              renderTextarea(
                {
                  id: 'draft-description',
                  value: draft.description,
                  placeholder: 'Add description…',
                  rows: 4,
                  onInput: description => Message.ChangedDraftDescription({ description }),
                },
                {
                  field: [],
                  label: [],
                  textarea: [
                    h.AriaLabel('Description'),
                    h.Class('min-h-24 w-full resize-none border-0 bg-transparent px-0 py-1 text-[14px] leading-relaxed outline-none placeholder:text-muted-foreground'),
                  ],
                  description: [],
                },
                h,
              ),
            ],
          ),
          h.div(
            [h.Class('flex flex-wrap items-center gap-1.5 px-4 pt-2 pb-3')],
            [
              property('status', `Status: ${statusLabel[draft.status]}`, [statusIcon(draft.status, h), statusLabel[draft.status]]),
              property('priority', `Priority: ${priorityLabel[draft.priority]}`, [
                priorityIcon(draft.priority, h, 'text-muted-foreground'),
                draft.priority === 0 ? 'Priority' : priorityLabel[draft.priority],
              ]),
              property('assignee', assignee === undefined ? 'Assignee' : `Assignee: ${assignee.name}`, [
                avatar(assignee, h, 'xs'),
                assignee === undefined ? 'Assignee' : firstName(assignee.name),
              ]),
              property(
                'labels',
                'Labels',
                draft.labelIds.length === 0
                  ? [Icon.icon('tag', { class: 'size-3.5 text-muted-foreground' }, h), 'Labels']
                  : draft.labelIds.map(id => h.span([h.Class('flex items-center gap-1')], [h.span([h.Class(cn('size-2 rounded-full', labelById(id)?.dot ?? ''))], []), labelById(id)?.name ?? id])),
              ),
            ],
          ),
          h.div(
            [h.Class('flex items-center gap-3 border-t px-4 py-2.5')],
            [
              h.p([h.Id('draft-error'), h.Class('flex-1 text-[12px] text-destructive'), h.AriaLive('polite')], [formError]),
              h.span([h.Class('text-[12px] text-muted-foreground')], [hint(h, 'Ctrl', 'Enter')]),
              button(
                {
                  id: 'draft-submit',
                  children: ['Create issue'],
                  type: 'submit',
                  size: 'sm',
                  class: 'h-8 text-[13px]',
                  isLoading: draft.isSaving,
                  loadingContent: ['Creating…'],
                },
                h,
              ),
            ],
          ),
        ],
      ),
    ],
  )
}

const toastView = (toast: Toast | null, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Id('toast'), h.AriaLive('polite'), h.Class('pointer-events-none fixed right-4 bottom-4 z-50')],
    toast === null
      ? []
      : [
          h.div(
            [h.Class('pointer-events-auto flex items-center gap-3 rounded-lg border bg-popover px-3.5 py-2.5 text-[13px] shadow-lg')],
            [
              Icon.icon('circle-check', { class: 'size-4 text-emerald-600' }, h),
              h.span([h.Class('font-medium')], [toast.text]),
              ...(toast.href === null
                ? []
                : [h.a([h.Href(toast.href), h.Class('font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline')], ['View issue'])]),
              h.button(
                [h.Type('button'), h.AriaLabel('Dismiss'), h.Class('text-muted-foreground hover:text-foreground'), h.OnClick(Message.ClickedDismissToast())],
                [Icon.x({ class: 'size-3.5' }, h)],
              ),
            ],
          ),
        ],
  )

const pickerTitle = (model: Model, picker: Picker.Picker): string | undefined => {
  if (picker.target !== 'issues') return undefined
  const issues = targetIssues(model, picker)
  return issues.length === 1 ? `${issues[0]?.identifier} ${issues[0]?.title}` : `${issues.length} issues`
}

const pickerLayer = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Id('picker-root')],
    model.picker === null
      ? []
      : [
          Picker.pickerView(
            {
              picker: model.picker,
              items: pickerItems(model, model.picker),
              itemIcon: item =>
                model.picker?.target === 'filter'
                  ? propertyIcon(filterField(item.value), item.value.split(':')[1] ?? '', model.members, h)
                  : model.picker?.target === 'palette'
                    ? undefined
                    : propertyIcon(model.picker?.field ?? 'status', item.value, model.members, h),
              onQuery: query => Message.ChangedPickerQuery({ query }),
              onKey: key => Message.PressedPickerKey({ key }),
              onChoose: value => Message.ClickedPickerItem({ value }),
              onClose: Message.ClickedClosePicker(),
              ...(pickerTitle(model, model.picker) === undefined ? {} : { title: pickerTitle(model, model.picker)! }),
            },
            h,
          ),
        ],
  )

const filterField = (value: string): Picker.PickerField => {
  const dimension = value.split(':')[0]
  return dimension === 'status' ? 'status' : dimension === 'priority' ? 'priority' : dimension === 'assignee' ? 'assignee' : 'labels'
}

const HELP_SHORTCUTS: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
  [['J', 'K'], 'Move the selection'],
  [['Enter'], 'Open the selected issue'],
  [['C'], 'Create an issue'],
  [['S'], 'Change status'],
  [['P'], 'Change priority'],
  [['A'], 'Change assignee'],
  [['L'], 'Change labels'],
  [['/'], 'Search'],
  [['⌘', 'K'], 'Command palette'],
  [['G', 'M'], 'Go to My issues'],
  [['⌘', 'B'], 'Switch list and board'],
  [['?'], 'Show these shortcuts'],
]

const helpDialog = (help: Dialog.Model, h: HtmlBuilder<Message>): Html =>
  Dialog.dialog(
    {
      model: help,
      toParentMessage: message => Message.GotHelpDialog({ message }),
      title: 'Keyboard shortcuts',
      description: 'Available on every issue list.',
      content: () => [
        h.ul(
          [h.Class('flex flex-col gap-2 text-sm')],
          HELP_SHORTCUTS.map(([keys, label]) =>
            h.li(
              [h.Class('flex items-center justify-between gap-4')],
              [h.span([], [label]), h.span([h.Class('flex gap-1')], keys.map(key => kbd({ children: [key] }, h)))],
            ),
          ),
        ),
      ],
    },
    h,
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const visible = visibleIssues(model)
  const groups = groupsOf(visible, model.query.layout)
  const navCounts = counts(model)
  const active = activeHref(model)
  const hasOverlay = model.picker !== null || model.draft !== null || model.help.isOpen
  return {
    title: `${scopeTitle(model.scope)} · Linear`,
    body: h.div(
      [h.Id('app'), h.Class(cn('flex h-screen overflow-hidden bg-background text-foreground', model.me.isDark && 'dark'))],
      [
        region(h, {
          id: 'sidebar',
          deps: [model.me, navCounts, active],
          render: () =>
            sidebar(
              {
                me: model.me,
                active,
                counts: navCounts,
                onCreate: { message: Message.ClickedCreate({ status: null }) },
                onPalette: Message.ClickedOpenPicker({ field: 'command', target: 'palette', issueId: null, anchor: null }),
                isDark: model.me.isDark,
                onToggleTheme: Message.ClickedToggleTheme(),
              },
              h,
            ),
        }),
        h.main(
          [h.Class('flex min-w-0 flex-1 flex-col bg-background')],
          [
            region(h, { id: 'header', deps: [model.scope, model.query, active], render: () => header(model, h) }),
            region(h, { id: 'filter-bar', deps: [model.query, model.members], render: () => filterBar(model, h) }),
            region(h, {
              id: 'issue-list',
              deps: [model.query.layout, groups, model.members, model.selectedId, model.collapsed, model.dragging, model.dropTarget, model.query.search, model.query.status, model.query.priority, model.query.assignee, model.query.label],
              render: () => (model.query.layout === 'board' ? boardView(model, groups, h) : listView(model, groups, h)),
            }),
          ],
        ),
        region(h, { id: 'help', deps: [model.help], render: () => h.div([h.Id('help')], [helpDialog(model.help, h)]) }),
        region(h, {
          id: 'new-issue-root',
          deps: [model.draft, model.members],
          render: () => h.div([h.Id('new-issue-root')], model.draft === null ? [] : [draftDialog(model, model.draft, h)]),
        }),
        region(h, {
          id: 'picker-root',
          deps: [model.picker, model.picker === null ? null : pickerItems(model, model.picker), model.members, model.picker === null ? null : pickerTitle(model, model.picker)],
          render: () => pickerLayer(model, h),
        }),
        region(h, { id: 'toast', deps: [model.toast], render: () => toastView(model.toast, h) }),
        region(h, {
          id: 'shortcuts',
          deps: [hasOverlay, model.query.layout],
          render: () =>
            h.div(
              [h.Id('shortcuts')],
              [
                keyBindings(
                  h,
                  shortcutBindings<Message>(
                    hasOverlay,
                    (shortcut, targetId) => Message.PressedShortcut({ shortcut, targetId }),
                    model.query.layout === 'board'
                      ? undefined
                      : { within: '#issue-list', moved: elementId => Message.MovedSelection({ elementId }) },
                  ),
                ),
              ],
            ),
        }),
      ],
    ),
  }
}

// PROGRAM

const scopeOf = (request: PageRequest): Effect.Effect<Scope, PageNotFound> => {
  if (request.url.pathname === '/my-issues') return Effect.succeed({ _tag: 'Mine' })
  if (request.url.pathname === '/issues') return Effect.succeed({ _tag: 'All' })
  return Option.match(decodeTeam((request.params['team'] ?? '').toUpperCase()), {
    onNone: () => Effect.fail(new PageNotFound()),
    onSome: team => Effect.succeed({ _tag: 'Team' as const, team }),
  })
}

/** Serves `/team/:team`, `/my-issues` and `/issues` (see `paths`). */
export const program: Program<Model, Message, ClientMessage, Flags, Workspace> = {
  name: 'issues',
  Model,
  ClientMessage,
  flags: request =>
    Effect.gen(function* () {
      const user = yield* requireUser(request)
      const scope = yield* scopeOf(request)
      const workspace = yield* Workspace
      const me = yield* workspace.memberFor(user)
      const state = yield* workspace.current
      return {
        me,
        scope,
        query: queryFromUrl(request.url),
        members: state.members,
        issues: state.issues,
        isCreating: request.url.searchParams.get('new') === '1',
      }
    }),
  init,
  update,
  view,
  subscriptions,
  clientCommands: {
    ReplaceUrl: ({ url }) => (typeof url === 'string' ? { replaceUrl: url } : undefined),
    LoadUrl: ({ url }) => (typeof url === 'string' ? { load: url } : undefined),
    ScrollIntoView: ({ selector }) => (typeof selector === 'string' ? { scrollIntoView: selector } : undefined),
    FocusElement: ({ selector }) => (typeof selector === 'string' ? { focus: selector } : undefined),
  },
  // The session's own state; the workspace comes back from the Subscription.
  onUrlChange: request =>
    Effect.gen(function* () {
      yield* requireUser(request)
      const scope = yield* scopeOf(request)
      return Message.ChangedUrl({ scope, query: queryFromUrl(request.url) })
    }),
  snapshotDeps: model => [model.scope, model.query, model.selectedId, model.collapsed, model.picker, model.draft, model.toast],
}

export const paths = ['/my-issues', '/issues']
