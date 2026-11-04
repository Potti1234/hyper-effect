import { Duration, Effect, Match as M, Option, Schema as S, Stream } from 'effect'
import { Command, Subscription, type Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import * as Navigation from 'foldkit/navigation'

import { PageNotFound, type Program, keyBindings, region, sampleLatest } from '@hyper-effect/core'

import * as Icon from '@/lib/icon'
import { renderTextarea } from '@/lib/textarea'
import { cn } from '@/lib/utils'
import { button } from '@/ui/button'
import * as DropdownMenu from '@/ui/dropdown-menu'
import { input } from '@/ui/input'
import { textarea } from '@/ui/textarea'

import { requireUser } from '../auth'
import {
  Activity,
  Comment,
  CommentBody,
  Description,
  Issue,
  IssueChange,
  Member,
  TEAMS,
  Title,
  firstError,
  firstName,
  formatDate,
  formatDateTime,
  isClosed,
  priorityLabel,
  statusLabel,
  teamName,
} from '../domain'
import { Shortcut, shortcutBindings } from '../shortcuts/contract'
import { Viewers, Workspace, type WorkspaceState } from '../store'
import { avatar, labelChip, priorityIcon, statusIcon, teamBadge } from '../view/icons'
import * as Picker from '../view/picker'
import { patchFor, propertyIcon, propertyItems, valuesOf } from '../view/properties'
import { type NavCounts, sidebar } from '../view/shell'

/* One issue: editable title and description, properties changed through the
   picker, comments, the activity log, and who else is looking at it. All of
   it is live: a change anyone makes reaches every open copy of this page. */

// MODEL

const FocusRequest = S.Struct({ selector: S.String, seq: S.Number })
const Counts = S.Struct({ my: S.Number, ENG: S.Number, DES: S.Number })

export const Model = S.Struct({
  me: Member,
  identifier: S.String,
  /** Null once someone deleted it. */
  issue: S.NullOr(Issue),
  members: S.Array(Member),
  comments: S.Array(Comment),
  activity: S.Array(Activity),
  counts: Counts,
  /** Member ids with this issue open right now (me included). */
  viewers: S.Array(S.String),
  isConnected: S.Boolean,
  /** What the user is typing into the title/description; null when they are
   *  not editing it, so changes from others show at once. */
  titleDraft: S.NullOr(S.String),
  titleError: S.NullOr(S.String),
  descriptionDraft: S.NullOr(S.String),
  comment: S.String,
  commentError: S.NullOr(S.String),
  isPosting: S.Boolean,
  picker: S.NullOr(Picker.Picker),
  menu: DropdownMenu.Model,
  focus: S.NullOr(FocusRequest),
  notice: S.NullOr(S.String),
  seq: S.Number,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ChangedTitle: { title: S.String },
  SubmittedTitle: {},
  ChangedDescription: { description: S.String },
  BlurredDescription: {},
  ChangedComment: { text: S.String },
  SubmittedComment: {},
  ClickedOpenPicker: { field: Picker.PickerField, anchor: S.NullOr(S.String) },
  ChangedPickerQuery: { query: S.String },
  PressedPickerKey: { key: S.String },
  ClickedPickerItem: { value: S.String },
  ClickedClosePicker: {},
  GotMenuMessage: { message: DropdownMenu.Message },
  ClickedToggleTheme: {},
  ClickedDismissNotice: {},
  PressedShortcut: { shortcut: Shortcut, targetId: S.String },
  GotIssue: {
    issue: S.NullOr(Issue),
    members: S.Array(Member),
    comments: S.Array(Comment),
    activity: S.Array(Activity),
    counts: Counts,
  },
  ChangedViewers: { viewers: S.Array(S.String) },
  ChangedConnection: { isConnected: S.Boolean },
  SucceededSaveTitle: {},
  SucceededSaveDescription: {},
  SucceededPostComment: {},
  FailedChange: { reason: S.String },
  CompletedChange: {},
  SucceededDelete: { team: S.String },
  ExpiredNotice: { seq: S.Number },
  CompletedBrowserAction: {},
})
export type Message = typeof Message.Type

export const ClientMessage = S.Union([
  Message.SubmittedTitle,
  Message.BlurredDescription,
  Message.SubmittedComment,
  Message.ClickedOpenPicker,
  Message.ClickedPickerItem,
  Message.ClickedClosePicker,
  Message.GotMenuMessage,
  Message.ClickedToggleTheme,
  Message.ClickedDismissNotice,
])
export type ClientMessage = typeof ClientMessage.Type

// COMMAND

const failed = (reason: string) => Effect.succeed(Message.FailedChange({ reason }))

export const SaveIssue = Command.define('SaveIssue', {
  args: { changes: S.Array(IssueChange), actorId: S.String, field: S.Literals(['title', 'description', 'property']) },
  messages: [Message.SucceededSaveTitle, Message.SucceededSaveDescription, Message.CompletedChange, Message.FailedChange],
  execute: ({ changes, actorId, field }) =>
    Workspace.use(workspace => workspace.update(changes, actorId)).pipe(
      Effect.as(
        field === 'title' ? Message.SucceededSaveTitle() : field === 'description' ? Message.SucceededSaveDescription() : Message.CompletedChange(),
      ),
      Effect.catchTags({
        IssueNotFound: () => failed('This issue was deleted.'),
        InvalidChange: ({ reason }) => failed(reason),
      }),
    ),
})

export const PostComment = Command.define('PostComment', {
  args: { issueId: S.String, body: S.String, authorId: S.String },
  messages: [Message.SucceededPostComment, Message.FailedChange],
  execute: ({ issueId, body, authorId }) =>
    Workspace.use(workspace => workspace.comment(issueId, body, authorId)).pipe(
      Effect.as(Message.SucceededPostComment()),
      Effect.catchTag('IssueNotFound', () => failed('This issue was deleted.')),
    ),
})

export const DeleteIssue = Command.define('DeleteIssue', {
  args: { issueId: S.String, team: S.String },
  messages: [Message.SucceededDelete, Message.FailedChange],
  execute: ({ issueId, team }) =>
    Workspace.use(workspace => workspace.remove(issueId)).pipe(
      Effect.as(Message.SucceededDelete({ team })),
      Effect.catchTag('IssueNotFound', () => Effect.succeed(Message.SucceededDelete({ team }))),
    ),
})

export const SetTheme = Command.define('SetTheme', {
  args: { memberId: S.String, isDark: S.Boolean },
  messages: [Message.CompletedChange],
  execute: ({ memberId, isDark }) =>
    Workspace.use(workspace => workspace.setTheme(memberId, isDark)).pipe(Effect.as(Message.CompletedChange())),
})

export const ExpireNotice = Command.define('ExpireNotice', {
  args: { seq: S.Number },
  messages: [Message.ExpiredNotice],
  execute: ({ seq }) => Effect.sleep(Duration.seconds(6)).pipe(Effect.as(Message.ExpiredNotice({ seq }))),
})

/** Forwarded to the page (see `clientCommands`). */
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
  identifier: string
  issue: Issue
  members: ReadonlyArray<Member>
  comments: ReadonlyArray<Comment>
  activity: ReadonlyArray<Activity>
  counts: NavCounts
}>

const MENU_ID = 'issue-menu'

export const init = (flags: Flags): Update.Return<Model, Message> => ({
  model: {
    me: flags.me,
    identifier: flags.identifier,
    issue: flags.issue,
    members: flags.members,
    comments: flags.comments,
    activity: flags.activity,
    counts: flags.counts,
    viewers: [],
    isConnected: false,
    titleDraft: null,
    titleError: null,
    descriptionDraft: null,
    comment: '',
    commentError: null,
    isPosting: false,
    picker: null,
    menu: DropdownMenu.init({ id: MENU_ID }),
    focus: null,
    notice: null,
    seq: 0,
  },
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Workspace>

type MenuItem = 'delete' | 'back'
const Menu = DropdownMenu.create<MenuItem>()

const focusOn = (model: Model, selector: string): Model => ({ ...model, seq: model.seq + 1, focus: { selector, seq: model.seq + 1 } })

const showNotice = (model: Model, text: string): UpdateReturn => ({
  model: { ...model, seq: model.seq + 1, notice: text },
  commands: [ExpireNotice({ seq: model.seq + 1 })],
})

export const pickerItems = (model: Model, picker: Picker.Picker): ReadonlyArray<Picker.PickerItem> =>
  model.issue === null ? [] : propertyItems(picker.field, valuesOf([model.issue]), model.members, model.me)

const openPicker = (model: Model, field: Picker.PickerField, anchor: string | null): UpdateReturn =>
  model.issue === null || !['status', 'priority', 'assignee', 'labels'].includes(field)
    ? { model }
    : (() => {
        const opened = Picker.open(field, 'issues', [model.issue.id], anchor)
        const picker = Picker.isMultiSelect(field) ? opened : { ...opened, active: Picker.checkedIndex(pickerItems(model, opened)) }
        return { model: focusOn({ ...model, picker }, `#${Picker.PICKER_INPUT_ID}`) }
      })()

const choose = (model: Model, value: string): UpdateReturn => {
  const picker = model.picker
  const issue = model.issue
  if (picker === null || issue === null) return { model }
  return Option.match(patchFor(picker.field, value, [issue], model.members), {
    onNone: () => ({ model }),
    onSome: changes => ({
      model: Picker.isMultiSelect(picker.field) ? model : { ...model, picker: null },
      commands: [SaveIssue({ changes, actorId: model.me.id, field: 'property' })],
    }),
  })
}

const saveTitle = (model: Model): UpdateReturn => {
  const issue = model.issue
  if (issue === null || model.titleDraft === null) return { model }
  const title = model.titleDraft.trim()
  if (title === issue.title) return { model: { ...model, titleDraft: null, titleError: null } }
  const error = firstError(Title, title)
  return error !== null
    ? { model: { ...model, titleError: error } }
    : { model: { ...model, titleError: null }, commands: [SaveIssue({ changes: [{ id: issue.id, patch: { title } }], actorId: model.me.id, field: 'title' })] }
}

const saveDescription = (model: Model): UpdateReturn => {
  const issue = model.issue
  if (issue === null || model.descriptionDraft === null) return { model }
  const description = model.descriptionDraft.trim()
  if (description === issue.description) return { model: { ...model, descriptionDraft: null } }
  const error = firstError(Description, description)
  return error !== null
    ? showNotice(model, error)
    : { model, commands: [SaveIssue({ changes: [{ id: issue.id, patch: { description } }], actorId: model.me.id, field: 'description' })] }
}

const submitComment = (model: Model): UpdateReturn => {
  const issue = model.issue
  if (issue === null || model.isPosting) return { model }
  const body = model.comment.trim()
  const error = firstError(CommentBody, body)
  return error !== null
    ? { model: { ...model, commentError: error } }
    : { model: { ...model, isPosting: true, commentError: null }, commands: [PostComment({ issueId: issue.id, body, authorId: model.me.id })] }
}

const teamHref = (model: Model): string => `/team/${model.issue?.team ?? model.identifier.split('-')[0] ?? 'ENG'}`

const onShortcut = (model: Model, shortcut: Shortcut, targetId: string): UpdateReturn => {
  switch (shortcut) {
    case 'status':
    case 'priority':
    case 'assignee':
    case 'labels':
      return model.picker === null ? openPicker(model, shortcut, null) : { model }
    case 'escape':
      return model.picker !== null
        ? { model: { ...model, picker: null } }
        : model.menu.isOpen
          ? { model: { ...model, menu: Menu.close(model.menu).model } }
          : { model, commands: [LoadUrl({ url: teamHref(model) })] }
    case 'submit':
      return targetId === 'comment-input' ? submitComment(model) : targetId === 'issue-description' ? saveDescription(model) : { model }
    case 'create':
      return { model, commands: [LoadUrl({ url: `${teamHref(model)}?new=1` })] }
    case 'palette':
      return { model, commands: [LoadUrl({ url: `${teamHref(model)}` })] }
    case 'goMyIssues':
      return { model, commands: [LoadUrl({ url: '/my-issues' })] }
    case 'goEngineering':
      return { model, commands: [LoadUrl({ url: '/team/ENG' })] }
    case 'goDesign':
      return { model, commands: [LoadUrl({ url: '/team/DES' })] }
    default:
      return { model }
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
      ChangedTitle: ({ title }) => ({ model: { ...model, titleDraft: title, titleError: null } }),
      SubmittedTitle: () => saveTitle(model),
      ChangedDescription: ({ description }) => ({ model: { ...model, descriptionDraft: description } }),
      BlurredDescription: () => saveDescription(model),
      ChangedComment: ({ text }) => ({ model: { ...model, comment: text, commentError: null } }),
      SubmittedComment: () => submitComment(model),
      ClickedOpenPicker: ({ field, anchor }) => openPicker(model, field, anchor),
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
            return pickerItems(model, picker).some(item => item.value === action.value) ? choose(model, action.value) : { model }
          case 'close':
            return { model: { ...model, picker: null } }
          case 'none':
            return { model }
        }
      },
      ClickedPickerItem: ({ value }) =>
        model.picker !== null && pickerItems(model, model.picker).some(item => item.value === value) ? choose(model, value) : { model },
      ClickedClosePicker: () => ({ model: { ...model, picker: null } }),
      GotMenuMessage: ({ message: menuMessage }) => {
        const next = Menu.update(model.menu, menuMessage)
        const nextModel = { ...model, menu: next.model }
        const selected = next.outMessage?.value
        if (selected === 'back') return { model: nextModel, commands: [LoadUrl({ url: teamHref(model) })] }
        if (selected === 'delete' && model.issue !== null) {
          return { model: nextModel, commands: [DeleteIssue({ issueId: model.issue.id, team: model.issue.team })] }
        }
        return { model: nextModel }
      },
      ClickedToggleTheme: () => ({ model, commands: [SetTheme({ memberId: model.me.id, isDark: !model.me.isDark })] }),
      ClickedDismissNotice: () => ({ model: { ...model, notice: null } }),
      PressedShortcut: ({ shortcut, targetId }) => onShortcut(model, shortcut, targetId),
      GotIssue: ({ issue, members, comments, activity, counts }) => ({
        model: {
          ...model,
          issue,
          members,
          comments,
          activity,
          counts,
          me: members.find(member => member.id === model.me.id) ?? model.me,
          picker: issue === null ? null : model.picker,
        },
      }),
      ChangedViewers: ({ viewers }) => ({ model: { ...model, viewers } }),
      ChangedConnection: ({ isConnected }) => ({ model: { ...model, isConnected } }),
      // The draft goes only once the save is done, so the field never shows the old text in between.
      SucceededSaveTitle: () => ({ model: { ...model, titleDraft: null } }),
      SucceededSaveDescription: () => ({ model: { ...model, descriptionDraft: null } }),
      SucceededPostComment: () => ({ model: { ...model, comment: '', isPosting: false, commentError: null } }),
      FailedChange: ({ reason }) => showNotice({ ...model, isPosting: false }, reason),
      CompletedChange: () => ({ model }),
      SucceededDelete: ({ team }) => ({ model, commands: [LoadUrl({ url: `/team/${team}` })] }),
      ExpiredNotice: ({ seq }) => (model.seq === seq ? { model: { ...model, notice: null } } : { model }),
      CompletedBrowserAction: () => ({ model }),
    }),
  )

// SUBSCRIPTION

type IssueSlice = Readonly<{
  issue: Issue | null
  members: ReadonlyArray<Member>
  comments: ReadonlyArray<Comment>
  activity: ReadonlyArray<Activity>
  counts: NavCounts
}>

const countsOf = (state: WorkspaceState, memberId: string): NavCounts => ({
  my: state.issues.filter(issue => issue.assigneeId === memberId && !isClosed(issue.status)).length,
  ENG: state.issues.filter(issue => issue.team === 'ENG' && !isClosed(issue.status)).length,
  DES: state.issues.filter(issue => issue.team === 'DES' && !isClosed(issue.status)).length,
})

export const sliceOf = (state: WorkspaceState, identifier: string, memberId: string): IssueSlice => {
  const issue = state.issues.find(candidate => candidate.identifier === identifier) ?? null
  return {
    issue,
    members: state.members,
    comments: issue === null ? [] : state.comments.filter(comment => comment.issueId === issue.id),
    activity: issue === null ? [] : state.activity.filter(entry => entry.issueId === issue.id),
    counts: countsOf(state, memberId),
  }
}

const sameItems = <A>(a: ReadonlyArray<A>, b: ReadonlyArray<A>): boolean => a.length === b.length && a.every((item, index) => item === b[index])

const sameSlice = (a: IssueSlice, b: IssueSlice): boolean =>
  a.issue === b.issue &&
  a.members === b.members &&
  sameItems(a.comments, b.comments) &&
  sameItems(a.activity, b.activity) &&
  a.counts.my === b.counts.my &&
  a.counts.ENG === b.counts.ENG &&
  a.counts.DES === b.counts.DES

export const subscriptions = Subscription.make<Model, Message, Workspace | Viewers>()(entry => ({
  issue: entry(
    { identifier: S.String, memberId: S.String },
    {
      modelToDependencies: model => ({ identifier: model.identifier, memberId: model.me.id }),
      dependenciesToStream: ({ identifier, memberId }) =>
        Stream.unwrap(
          Workspace.use(workspace =>
            Effect.succeed(
              workspace.changes.pipe(
                Stream.map(state => sliceOf(state, identifier, memberId)),
                Stream.changesWith(sameSlice),
                Stream.map(slice => Message.GotIssue(slice)),
              ),
            ),
          ),
        ),
    },
  ),
  // Viewing while the page is connected: joining is scoped to this stream.
  viewers: entry(
    { issueId: S.NullOr(S.String), memberId: S.String, isConnected: S.Boolean },
    {
      modelToDependencies: model => ({ issueId: model.issue?.id ?? null, memberId: model.me.id, isConnected: model.isConnected }),
      dependenciesToStream: ({ issueId, memberId, isConnected }) =>
        !isConnected || issueId === null
          ? Stream.empty
          : Stream.unwrap(
              Effect.gen(function* () {
                const viewers = yield* Viewers
                yield* viewers.join(issueId, memberId)
                return viewers.of(issueId).pipe(
                  sampleLatest('300 millis'),
                  Stream.map(ids => Message.ChangedViewers({ viewers: ids })),
                )
              }),
            ),
    },
  ),
}))

// VIEW

const anchorName = (field: string) => `--anchor-detail-${field}`

const propertyButton = (
  h: HtmlBuilder<Message>,
  field: Picker.PickerField,
  label: string,
  children: ReadonlyArray<Html | string>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.Id(`property-${field}`),
      h.AriaLabel(label),
      h.AriaHasPopup('dialog'),
      h.Class('flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] font-medium hover:bg-accent'),
      h.Style({ anchorName: anchorName(field) }),
      h.OnClick(Message.ClickedOpenPicker({ field, anchor: anchorName(field) })),
    ],
    [...children],
  )

const memberOf = (members: ReadonlyArray<Member>, id: string | null): Member | undefined =>
  id === null ? undefined : members.find(member => member.id === id)

const propertiesPanel = (issue: Issue, members: ReadonlyArray<Member>, h: HtmlBuilder<Message>): Html => {
  const assignee = memberOf(members, issue.assigneeId)
  const creator = memberOf(members, issue.creatorId)
  const row = (label: string, value: Html) =>
    h.div([h.Class('grid grid-cols-[84px_1fr] items-center gap-1')], [h.span([h.Class('text-[12px] text-muted-foreground')], [label]), value])
  return h.aside(
    [h.Id('properties'), h.AriaLabel('Properties'), h.Class('flex w-[280px] shrink-0 flex-col gap-1 overflow-y-auto border-l bg-muted/20 px-4 py-4')],
    [
      h.div([h.Class('px-2 pb-2 text-[12px] font-medium text-muted-foreground')], ['Properties']),
      row('Status', propertyButton(h, 'status', `Status: ${statusLabel[issue.status]}`, [statusIcon(issue.status, h), statusLabel[issue.status]])),
      row(
        'Priority',
        propertyButton(h, 'priority', `Priority: ${priorityLabel[issue.priority]}`, [
          priorityIcon(issue.priority, h, 'text-muted-foreground'),
          priorityLabel[issue.priority],
        ]),
      ),
      row(
        'Assignee',
        propertyButton(h, 'assignee', assignee === undefined ? 'Assignee: none' : `Assignee: ${assignee.name}`, [
          avatar(assignee, h, 'sm'),
          h.span([h.Class(cn('truncate', assignee === undefined && 'text-muted-foreground'))], [assignee?.name ?? 'Unassigned']),
        ]),
      ),
      row(
        'Labels',
        propertyButton(
          h,
          'labels',
          'Labels',
          issue.labelIds.length === 0
            ? [h.span([h.Class('text-muted-foreground')], ['Add label'])]
            : [h.span([h.Class('flex min-w-0 flex-1 flex-wrap gap-1 py-1')], issue.labelIds.map(id => labelChip(id, h)))],
        ),
      ),
      h.div([h.Class('my-3 border-t')], []),
      row(
        'Team',
        h.a(
          [h.Href(`/team/${issue.team}`), h.Class('flex h-8 items-center gap-2 rounded-md px-2 text-[13px] font-medium hover:bg-accent')],
          [teamBadge(TEAMS.find(team => team.key === issue.team)?.color ?? 'bg-slate-500', issue.team.charAt(0), h, 'size-4 text-[9px]'), teamName(issue.team)],
        ),
      ),
      row('Created', h.span([h.Class('px-2 text-[13px]')], [formatDate(issue.createdAt), creator === undefined ? '' : ` by ${firstName(creator.name)}`])),
      row('Updated', h.span([h.Class('px-2 text-[13px]'), h.Id('updated-at')], [formatDateTime(issue.updatedAt)])),
    ],
  )
}

const viewersView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const others = model.viewers.filter(id => id !== model.me.id)
  const people = others.map(id => memberOf(model.members, id)).filter((member): member is Member => member !== undefined)
  return h.div(
    [h.Id('viewers'), h.Class('flex items-center gap-2'), h.AriaLive('polite')],
    people.length === 0
      ? []
      : [
          h.div(
            [h.Class('flex -space-x-1.5')],
            people.map(member => h.span([h.Key(member.id), h.Class('rounded-full ring-2 ring-background')], [avatar(member, h, 'md')])),
          ),
          h.span(
            [h.Class('text-[12px] text-muted-foreground')],
            [`${people.map(member => firstName(member.name)).join(', ')} ${people.length === 1 ? 'is' : 'are'} viewing`],
          ),
        ],
  )
}

const topBar = (model: Model, h: HtmlBuilder<Message>): Html => {
  const issue = model.issue
  const team = TEAMS.find(candidate => candidate.key === issue?.team)
  return h.header(
    [h.Id('issue-header'), h.Class('flex h-12 shrink-0 items-center gap-2 border-b px-4')],
    [
      ...(team === undefined
        ? []
        : [
            h.a(
              [h.Href(`/team/${team.key}`), h.Class('flex items-center gap-2 rounded-md px-1 py-0.5 text-[13px] font-medium hover:bg-accent')],
              [teamBadge(team.color, team.key.charAt(0), h), team.name],
            ),
            Icon.icon('chevron-right', { class: 'size-3.5 text-muted-foreground' }, h),
          ]),
      h.span([h.Class('text-[13px] font-medium text-muted-foreground')], [model.identifier]),
      h.div([h.Class('flex-1')], []),
      region(h, { id: 'viewers', deps: [model.viewers, model.members, model.me.id], render: () => viewersView(model, h) }),
      ...(issue === null
        ? []
        : [
            region(h, {
              id: 'issue-menu-region',
              deps: [model.menu],
              render: () =>
                h.div(
                  [h.Id('issue-menu-region')],
                  [
                    DropdownMenu.dropdownMenu<MenuItem, Message>(
                      {
                        model: model.menu,
                        toParentMessage: message => Message.GotMenuMessage({ message }),
                        trigger: Icon.icon('ellipsis', { class: 'size-4' }, h),
                        triggerAriaLabel: 'Issue actions',
                        triggerClass: 'flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground',
                        items: ['back', 'delete'],
                        align: 'end',
                        ariaLabel: 'Issue actions',
                        contentClass: 'w-48 text-[13px]',
                        // Hover styled in CSS: no round trip per item crossed.
                        activateOnHover: false,
                        itemToConfig: item =>
                          item === 'back'
                            ? { label: 'Back to list', icon: Icon.icon('arrow-left', { class: 'size-4' }, h), shortcut: 'Esc' }
                            : { label: 'Delete issue', icon: Icon.icon('trash-2', { class: 'size-4' }, h), variant: 'destructive', separatorBefore: true },
                      },
                      h,
                    ),
                  ],
                ),
            }),
          ]),
    ],
  )
}

const titleEditor = (model: Model, issue: Issue, h: HtmlBuilder<Message>): Html =>
  h.form(
    [h.Id('title-form'), h.OnSubmit(Message.SubmittedTitle()), h.OnFocusLeave(Message.SubmittedTitle()), h.Class('grid gap-1')],
    [
      input(
        {
          id: 'issue-title',
          value: model.titleDraft ?? issue.title,
          ariaLabel: 'Issue title',
          autocomplete: 'off',
          isInvalid: model.titleError !== null,
          onInput: title => Message.ChangedTitle({ title }),
          class:
            'h-auto border-0 px-0 py-1 text-[22px] font-semibold tracking-[-0.01em] shadow-none focus-visible:ring-0 md:text-[22px] dark:bg-transparent aria-invalid:ring-0',
        },
        h,
      ),
      ...(model.titleError === null ? [] : [h.p([h.Id('title-error'), h.Class('text-[12px] text-destructive')], [model.titleError])]),
    ],
  )

const descriptionEditor = (model: Model, issue: Issue, h: HtmlBuilder<Message>): Html =>
  textarea(
    {
      id: 'issue-description',
      value: model.descriptionDraft ?? issue.description,
      placeholder: 'Add description…',
      rows: 3,
      resize: 'none',
      onInput: description => Message.ChangedDescription({ description }),
      // crease's `attributes` prop: saved when the field loses focus.
      attributes: [h.AriaLabel('Description'), h.OnBlur(Message.BlurredDescription())],
      class:
        'min-h-20 rounded-md border-transparent bg-transparent px-0 py-1 text-[14px] leading-relaxed shadow-none placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent md:text-[14px]',
    },
    h,
  )

type TimelineEntry = Readonly<{ _tag: 'activity'; entry: Activity } | { _tag: 'comment'; comment: Comment }>

const timeline = (model: Model): ReadonlyArray<TimelineEntry> =>
  [
    ...model.activity.map(entry => ({ _tag: 'activity' as const, entry, at: entry.at })),
    ...model.comments.map(comment => ({ _tag: 'comment' as const, comment, at: comment.createdAt })),
  ]
    .sort((a, b) => a.at - b.at)
    .map(({ at: _at, ...item }) => item as TimelineEntry)

const ACTIVITY_ICON: Readonly<Record<Activity['kind'], string>> = {
  created: 'circle-plus',
  status: 'circle-dot',
  priority: 'chart-column',
  assignee: 'user',
  labels: 'tag',
  title: 'pencil',
  description: 'file-text',
}

const activityItem = (entry: Activity, members: ReadonlyArray<Member>, h: HtmlBuilder<Message>): Html => {
  const actor = memberOf(members, entry.actorId)
  return h.li(
    [h.Key(entry.id), h.Id(`activity-${entry.id}`), h.DataAttribute('kind', entry.kind), h.Class('flex items-center gap-2.5 py-1.5 pl-1 text-[12px] text-muted-foreground')],
    [
      h.span([h.Class('flex size-5 items-center justify-center')], [Icon.icon(ACTIVITY_ICON[entry.kind], { class: 'size-3.5' }, h)]),
      h.span(
        [h.Class('min-w-0 flex-1')],
        [h.span([h.Class('font-medium text-foreground/80')], [actor?.name ?? 'Someone']), ` ${entry.text}`, h.span([h.Class('mx-1.5')], ['·']), formatDateTime(entry.at)],
      ),
    ],
  )
}

const commentItem = (comment: Comment, members: ReadonlyArray<Member>, h: HtmlBuilder<Message>): Html => {
  const author = memberOf(members, comment.authorId)
  return h.li(
    [h.Key(comment.id), h.Id(`comment-${comment.id}`), h.Class('my-2 rounded-lg border bg-card px-3.5 py-3 shadow-[0_1px_2px_rgb(0_0_0/0.03)]')],
    [
      h.div(
        [h.Class('flex items-center gap-2 text-[12px]')],
        [avatar(author, h, 'sm'), h.span([h.Class('font-medium')], [author?.name ?? 'Someone']), h.span([h.Class('text-muted-foreground')], [formatDateTime(comment.createdAt)])],
      ),
      h.p([h.Class('mt-1.5 pl-7 text-[13.5px] leading-relaxed whitespace-pre-wrap')], [comment.body]),
    ],
  )
}

const activitySection = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Id('activity'), h.AriaLabel('Activity')],
    [
      h.div(
        [h.Class('flex items-center justify-between border-b pb-2')],
        [h.h2([h.Class('text-[13px] font-semibold')], ['Activity']), h.span([h.Class('text-[12px] text-muted-foreground')], [`${model.comments.length} ${model.comments.length === 1 ? "comment" : "comments"}`])],
      ),
      h.ol(
        [h.Class('mt-2')],
        timeline(model).map(item => (item._tag === 'activity' ? activityItem(item.entry, model.members, h) : commentItem(item.comment, model.members, h))),
      ),
    ],
  )

const commentForm = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.form(
    [h.Id('comment-form'), h.OnSubmit(Message.SubmittedComment()), h.Class('mt-3 rounded-lg border bg-card shadow-[0_1px_2px_rgb(0_0_0/0.03)] focus-within:border-ring')],
    [
      renderTextarea(
        {
          id: 'comment-input',
          value: model.comment,
          placeholder: 'Leave a comment…',
          rows: 2,
          isInvalid: model.commentError !== null,
          onInput: text => Message.ChangedComment({ text }),
        },
        {
          field: [],
          label: [],
          textarea: [
            h.AriaLabel('Comment'),
            h.Class('field-sizing-content block min-h-16 w-full resize-none bg-transparent px-3.5 pt-3 text-[13.5px] outline-none placeholder:text-muted-foreground'),
          ],
          description: [],
        },
        h,
      ),
      h.div(
        [h.Class('flex items-center gap-3 px-3 pt-1 pb-2.5')],
        [
          h.p([h.Id('comment-error'), h.Class('flex-1 text-[12px] text-destructive'), h.AriaLive('polite')], [model.commentError ?? '']),
          h.span([h.Class('text-[11px] text-muted-foreground')], ['Ctrl+Enter']),
          button({ id: 'comment-submit', children: ['Comment'], type: 'submit', size: 'sm', variant: 'outline', class: 'h-7 text-[12px]', isLoading: model.isPosting }, h),
        ],
      ),
    ],
  )

const deletedView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Id('issue-body'), h.Class('flex flex-1 flex-col items-center justify-center gap-3 text-center')],
    [
      h.p([h.Class('text-[15px] font-medium')], [`${model.identifier} was deleted`]),
      h.a([h.Href(teamHref(model)), h.Class('text-[13px] text-muted-foreground underline-offset-4 hover:underline')], ['Back to the list']),
    ],
  )

const noticeView = (notice: string | null, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Id('notice'), h.AriaLive('polite'), h.Class('pointer-events-none fixed right-4 bottom-4 z-50')],
    notice === null
      ? []
      : [
          h.div(
            [h.Class('pointer-events-auto flex items-center gap-3 rounded-lg border bg-popover px-3.5 py-2.5 text-[13px] shadow-lg')],
            [
              Icon.icon('circle-alert', { class: 'size-4 text-amber-600' }, h),
              notice,
              h.button([h.Type('button'), h.AriaLabel('Dismiss'), h.Class('text-muted-foreground hover:text-foreground'), h.OnClick(Message.ClickedDismissNotice())], [Icon.x({ class: 'size-3.5' }, h)]),
            ],
          ),
        ],
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const issue = model.issue
  const hasOverlay = model.picker !== null
  return {
    title: issue === null ? `${model.identifier} · Linear` : `${issue.identifier} ${issue.title} · Linear`,
    body: h.div(
      [h.Id('app'), h.Class(cn('flex h-screen overflow-hidden bg-background text-foreground', model.me.isDark && 'dark'))],
      [
        region(h, {
          id: 'sidebar',
          deps: [model.me, model.counts, model.identifier],
          render: () =>
            sidebar(
              {
                me: model.me,
                active: '',
                counts: model.counts,
                onCreate: { href: `${teamHref(model)}?new=1` },
                isDark: model.me.isDark,
                onToggleTheme: Message.ClickedToggleTheme(),
              },
              h,
            ),
        }),
        h.main(
          [h.Class('flex min-w-0 flex-1 flex-col bg-background')],
          [
            topBar(model, h),
            issue === null
              ? deletedView(model, h)
              : h.div(
                  [h.Id('issue-body'), h.Class('flex min-h-0 flex-1')],
                  [
                    h.div(
                      [h.Class('min-w-0 flex-1 overflow-y-auto')],
                      [
                        h.div(
                          [h.Class('mx-auto w-full max-w-[760px] px-10 pt-8 pb-24')],
                          [
                            region(h, {
                              id: 'title-form',
                              deps: [model.titleDraft, model.titleError, issue.title],
                              render: () => titleEditor(model, issue, h),
                            }),
                            region(h, {
                              id: 'issue-description',
                              deps: [model.descriptionDraft, issue.description],
                              render: () => descriptionEditor(model, issue, h),
                            }),
                            h.div([h.Class('my-8 border-t')], []),
                            region(h, {
                              id: 'activity',
                              deps: [model.activity, model.comments, model.members],
                              render: () => activitySection(model, h),
                            }),
                            region(h, {
                              id: 'comment-form',
                              deps: [model.comment, model.commentError, model.isPosting],
                              render: () => commentForm(model, h),
                            }),
                          ],
                        ),
                      ],
                    ),
                    region(h, { id: 'properties', deps: [issue, model.members], render: () => propertiesPanel(issue, model.members, h) }),
                  ],
                ),
          ],
        ),
        region(h, {
          id: 'picker-root',
          deps: [model.picker, model.picker === null ? null : pickerItems(model, model.picker), model.members, issue?.identifier, issue?.title],
          render: () =>
            h.div(
              [h.Id('picker-root')],
              model.picker === null || issue === null
                ? []
                : [
                    Picker.pickerView(
                      {
                        picker: model.picker,
                        items: pickerItems(model, model.picker),
                        itemIcon: item => propertyIcon(model.picker?.field ?? 'status', item.value, model.members, h),
                        onQuery: query => Message.ChangedPickerQuery({ query }),
                        onKey: key => Message.PressedPickerKey({ key }),
                        onChoose: value => Message.ClickedPickerItem({ value }),
                        onClose: Message.ClickedClosePicker(),
                        title: `${issue.identifier} ${issue.title}`,
                      },
                      h,
                    ),
                  ],
            ),
        }),
        region(h, { id: 'notice', deps: [model.notice], render: () => noticeView(model.notice, h) }),
        region(h, {
          id: 'shortcuts',
          deps: [hasOverlay],
          render: () =>
            h.div(
              [h.Id('shortcuts')],
              [
                keyBindings(
                  h,
                  shortcutBindings(hasOverlay, (shortcut, targetId) => Message.PressedShortcut({ shortcut, targetId })),
                ),
              ],
            ),
        }),
      ],
    ),
  }
}

// PROGRAM

export const program: Program<Model, Message, ClientMessage, Flags, Workspace | Viewers> = {
  name: 'issue',
  Model,
  ClientMessage,
  flags: request =>
    Effect.gen(function* () {
      const user = yield* requireUser(request)
      const identifier = (request.params['identifier'] ?? '').toUpperCase()
      const workspace = yield* Workspace
      const me = yield* workspace.memberFor(user)
      const state = yield* workspace.current
      const slice = sliceOf(state, identifier, me.id)
      if (slice.issue === null) return yield* new PageNotFound()
      return { me, identifier, ...slice, issue: slice.issue }
    }),
  init,
  update,
  view,
  subscriptions,
  onConnectionChange: isConnected => Message.ChangedConnection({ isConnected }),
  clientCommands: {
    LoadUrl: ({ url }) => (typeof url === 'string' ? { load: url } : undefined),
    ScrollIntoView: ({ selector }) => (typeof selector === 'string' ? { scrollIntoView: selector } : undefined),
    FocusElement: ({ selector }) => (typeof selector === 'string' ? { focus: selector } : undefined),
  },
  snapshotDeps: model => [model.titleDraft, model.titleError, model.descriptionDraft, model.comment, model.commentError, model.picker, model.menu],
}
