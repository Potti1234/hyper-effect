import { Effect, Match as M, Schema as S, SchemaIssue, Stream } from 'effect'
import { Command, Subscription, type Update } from 'foldkit'
import * as Dom from 'foldkit/dom'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import { type Program, keyBindings, memoizeLast, region } from '@hyper-effect/core'

import { cn } from '@/lib/utils'
import { button } from '@/ui/button'
import { card, cardContent, cardHeader, cardTitle } from '@/ui/card'
import { input } from '@/ui/input'

import { requireUser } from '../auth'
import { Task, Tasks } from './store'

/* The task list: a Foldkit program whose loop runs on the server.

   - Model, Message, update and view are plain Foldkit; the browser only
     receives morphs and posts events.
   - Every page shows the shared list live, through a Subscription on the
     store's change feed.
   - Regions: each part of the page re-renders and travels only when its
     deps change; a change to one task sends one row. */

// MODEL

export const Filter = S.Literals(['all', 'open', 'done'])
export type Filter = typeof Filter.Type

export const Model = S.Struct({
  user: S.String,
  tasks: S.Array(Task),
  filter: Filter,
  /** What the user is typing; the input is client-owned (bound with
   *  onInput), so the morph never overwrites it while they type. */
  draft: S.String,
  draftError: S.NullOr(S.String),
  isAdding: S.Boolean,
  /** The last change that failed, such as a task someone else deleted. */
  notice: S.NullOr(S.String),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ChangedDraft: { title: S.String },
  SubmittedDraft: {},
  ClickedToggle: { id: S.String },
  ClickedRemove: { id: S.String },
  ClickedFilter: { filter: Filter },
  ClickedDismissNotice: {},
  PressedNewTask: {},
  CompletedFocus: {},
  GotTasks: { tasks: S.Array(Task) },
  SucceededAdd: {},
  CompletedChange: {},
  FailedChange: { reason: S.String },
})
export type Message = typeof Message.Type

/** The Messages a browser may post as they are. Typed text arrives through
 *  the session's handlers (onInput); store changes and Command results are
 *  server facts and cannot be forged. Anything posted is still checked in
 *  update: the browser is not trusted. */
export const ClientMessage = S.Union([
  Message.SubmittedDraft,
  Message.ClickedToggle,
  Message.ClickedRemove,
  Message.ClickedFilter,
  Message.ClickedDismissNotice,
  Message.PressedNewTask,
])
export type ClientMessage = typeof ClientMessage.Type

// VALIDATION

const MAX_TITLE = 120

export const Title = S.String.pipe(
  S.check(
    S.isMinLength(1, { message: 'Describe the task.' }),
    S.isMaxLength(MAX_TITLE, { message: `At most ${MAX_TITLE} characters.` }),
  ),
)
const decodeTitle = S.decodeUnknownExit(Title)
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

/** The trimmed title, or the message of the first check it fails. */
export const validateTitle = (draft: string): Readonly<{ title: string } | { error: string }> => {
  const decoded = decodeTitle(draft.trim())
  if (decoded._tag === 'Success') return { title: decoded.value }
  const error = decoded.cause.reasons.find(reason => reason._tag === 'Fail')?.error
  return {
    error: (S.isSchemaError(error) ? formatIssues(error.issue).issues[0]?.message : undefined) ?? 'Check the title.',
  }
}

// COMMAND

export const AddTask = Command.define('AddTask', {
  args: { title: S.String, by: S.String },
  messages: [Message.SucceededAdd],
  execute: ({ title, by }) =>
    Tasks.use(tasks => tasks.add(title, by)).pipe(Effect.as(Message.SucceededAdd())),
})

export const ToggleTask = Command.define('ToggleTask', {
  args: { id: S.String },
  messages: [Message.CompletedChange, Message.FailedChange],
  execute: ({ id }) =>
    Tasks.use(tasks => tasks.toggle(id)).pipe(
      Effect.as(Message.CompletedChange()),
      Effect.catchTag('TaskNotFound', () => Effect.succeed(Message.FailedChange({ reason: 'That task was just deleted.' }))),
    ),
})

export const RemoveTask = Command.define('RemoveTask', {
  args: { id: S.String },
  messages: [Message.CompletedChange, Message.FailedChange],
  execute: ({ id }) =>
    Tasks.use(tasks => tasks.remove(id)).pipe(
      Effect.as(Message.CompletedChange()),
      Effect.catchTag('TaskNotFound', () => Effect.succeed(Message.CompletedChange())),
    ),
})

/** Runs in the browser after the next morph: forwarded as a focus action
 *  (see `clientCommands` in the program). */
export const FocusNewTask = Command.define('FocusNewTask', {
  messages: [Message.CompletedFocus],
  execute: Dom.focus('#task-title').pipe(Effect.ignore, Effect.as(Message.CompletedFocus())),
})

// INIT

export type Flags = Readonly<{ user: string; tasks: ReadonlyArray<Task> }>

export const init = (flags: Flags): Update.Return<Model, Message> => ({
  model: {
    user: flags.user,
    tasks: flags.tasks,
    filter: 'all',
    draft: '',
    draftError: null,
    isAdding: false,
    notice: null,
  },
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Tasks>

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ChangedDraft: ({ title }) => ({ model: { ...model, draft: title, draftError: null } }),
      SubmittedDraft: () => {
        if (model.isAdding) return { model }
        const validated = validateTitle(model.draft)
        return 'error' in validated
          ? { model: { ...model, draftError: validated.error } }
          : { model: { ...model, isAdding: true }, commands: [AddTask({ title: validated.title, by: model.user })] }
      },
      // Clearing the draft in the Model clears the input: the server patches
      // a client-owned input when the Model diverges from what it sent.
      SucceededAdd: () => ({ model: { ...model, draft: '', isAdding: false } }),
      ClickedToggle: ({ id }) => ({ model, commands: [ToggleTask({ id })] }),
      ClickedRemove: ({ id }) => ({ model, commands: [RemoveTask({ id })] }),
      ClickedFilter: ({ filter }) => ({ model: { ...model, filter } }),
      ClickedDismissNotice: () => ({ model: { ...model, notice: null } }),
      PressedNewTask: () => ({ model, commands: [FocusNewTask()] }),
      CompletedFocus: () => ({ model }),
      GotTasks: ({ tasks }) => ({ model: { ...model, tasks } }),
      CompletedChange: () => ({ model }),
      FailedChange: ({ reason }) => ({ model: { ...model, notice: reason } }),
    }),
  )

// SUBSCRIPTION

// One Message per change of the list, shared by every session (instead of
// each session building its own copy).
const gotTasks = memoizeLast((tasks: ReadonlyArray<Task>) => Message.GotTasks({ tasks }))

export const subscriptions = Subscription.make<Model, Message, Tasks>()(entry => ({
  tasks: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Stream.unwrap(Tasks.use(tasks => Effect.succeed(tasks.changes.pipe(Stream.map(gotTasks))))),
    },
  ),
}))

// VIEW

const visibleTasks = (model: Model): ReadonlyArray<Task> =>
  model.filter === 'all' ? model.tasks : model.tasks.filter(task => task.isDone === (model.filter === 'done'))

const header = (user: string, h: HtmlBuilder<Message>): Html =>
  h.header(
    [h.Id('page-header'), h.Class('flex items-center justify-between gap-3 border-b bg-background px-4 py-3 sm:px-6')],
    [
      h.span([h.Class('text-base font-semibold')], ['Starter']),
      h.div(
        [h.Class('flex items-center gap-2 text-sm text-muted-foreground')],
        [
          h.span([], [user]),
          // A plain form post: signing out is a navigation, not an event.
          h.form(
            [h.Method('post'), h.Action('/logout')],
            [button({ children: ['Sign out'], type: 'submit', variant: 'ghost', size: 'sm' }, h)],
          ),
        ],
      ),
    ],
  )

const newTaskForm = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.form(
    [h.Id('new-task'), h.Class('flex items-start gap-2'), h.OnSubmit(Message.SubmittedDraft())],
    [
      h.div(
        [h.Class('flex-1')],
        [
          input(
            {
              id: 'task-title',
              ariaLabel: 'New task',
              value: model.draft,
              placeholder: 'What needs doing?',
              onInput: title => Message.ChangedDraft({ title }),
              ...(model.draftError === null ? {} : { description: model.draftError, isInvalid: true }),
            },
            h,
          ),
        ],
      ),
      button({ children: ['Add'], type: 'submit', isLoading: model.isAdding }, h),
    ],
  )

const FILTERS: ReadonlyArray<Readonly<{ value: Filter; label: string }>> = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'done', label: 'Done' },
]

const filters = (model: Model, h: HtmlBuilder<Message>): Html => {
  const open = model.tasks.filter(task => !task.isDone).length
  return h.div(
    [h.Id('filters'), h.Class('flex items-center justify-between gap-2 text-sm')],
    [
      h.div(
        [h.Class('flex gap-1'), h.Role('group'), h.AriaLabel('Show')],
        FILTERS.map(({ value, label }) =>
          button(
            {
              children: [label],
              variant: model.filter === value ? 'secondary' : 'ghost',
              size: 'sm',
              onClick: Message.ClickedFilter({ filter: value }),
            },
            h,
          ),
        ),
      ),
      h.span([h.Class('text-muted-foreground'), h.AriaLive('polite')], [`${open} open of ${model.tasks.length}`]),
    ],
  )
}

const taskRow = (task: Task, h: HtmlBuilder<Message>): Html =>
  h.li(
    [h.Id(`task-${task.id}`), h.Class('flex items-center gap-3 py-2')],
    [
      h.button(
        [
          h.Type('button'),
          h.Class(
            cn(
              'flex size-5 shrink-0 items-center justify-center rounded border text-xs',
              task.isDone && 'border-primary bg-primary text-primary-foreground',
            ),
          ),
          h.AriaPressed(task.isDone ? 'true' : 'false'),
          h.AriaLabel(`Done: ${task.title}`),
          h.OnClick(Message.ClickedToggle({ id: task.id })),
        ],
        [task.isDone ? '✓' : ''],
      ),
      h.div(
        [h.Class('min-w-0 flex-1')],
        [
          h.p([h.Class(cn('truncate', task.isDone && 'text-muted-foreground line-through'))], [task.title]),
          h.p([h.Class('text-xs text-muted-foreground')], [`by ${task.createdBy}`]),
        ],
      ),
      button(
        { children: ['Remove'], variant: 'ghost', size: 'xs', ariaLabel: `Remove ${task.title}`, onClick: Message.ClickedRemove({ id: task.id }) },
        h,
      ),
    ],
  )

const taskList = (tasks: ReadonlyArray<Task>, h: HtmlBuilder<Message>): Html =>
  tasks.length === 0
    ? h.p([h.Id('task-list'), h.Class('py-6 text-center text-sm text-muted-foreground')], ['Nothing here.'])
    : h.ul(
        [h.Id('task-list'), h.Class('divide-y')],
        // A region per task: a change to one task sends only its row.
        tasks.map(task => region(h, { id: `task-${task.id}`, deps: [task], render: () => taskRow(task, h) })),
      )

const notice = (message: string | null, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Id('notice'), h.AriaLive('polite')],
    message === null
      ? []
      : [
          h.div(
            [h.Class('flex items-center justify-between gap-2 rounded-md border bg-muted px-3 py-2 text-sm')],
            [
              message,
              button({ children: ['Dismiss'], variant: 'ghost', size: 'xs', onClick: Message.ClickedDismissNotice() }, h),
            ],
          ),
        ],
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const visible = visibleTasks(model)
  const open = model.tasks.filter(task => !task.isDone).length
  return {
    title: open === 0 ? 'Starter' : `(${open}) Starter`,
    body: h.div(
      [h.Class('flex min-h-screen flex-col bg-muted/30')],
      [
        // deps list every Model field the region's view reads; outside
        // production a region whose deps miss one fails to render.
        region(h, { id: 'page-header', deps: [model.user], render: () => header(model.user, h) }),
        // Shortcuts for the whole page, matched in the browser: only a
        // matching key posts its Message.
        keyBindings(h, [{ keys: 'N', message: Message.PressedNewTask() }]),
        h.main(
          [h.Class('mx-auto grid w-full max-w-2xl gap-4 p-4 sm:p-6')],
          [
            card(
              {
                children: [
                  cardHeader({ children: [cardTitle({ children: ['Tasks'] }, h)] }, h),
                  cardContent(
                    {
                      class: 'grid gap-4',
                      children: [
                        region(h, {
                          id: 'new-task',
                          deps: [model.draft, model.draftError, model.isAdding],
                          render: () => newTaskForm(model, h),
                        }),
                        region(h, { id: 'notice', deps: [model.notice], render: () => notice(model.notice, h) }),
                        region(h, { id: 'filters', deps: [model.filter, model.tasks], render: () => filters(model, h) }),
                        region(h, { id: 'task-list', deps: [visible], render: () => taskList(visible, h) }),
                      ],
                    },
                    h,
                  ),
                ],
              },
              h,
            ),
          ],
        ),
      ],
    ),
  }
}

// PROGRAM

export const program: Program<Model, Message, ClientMessage, Flags, Tasks> = {
  name: 'tasks',
  Model,
  ClientMessage,
  // Runs per page load: authenticate, then load what the page shows.
  flags: request =>
    Effect.gen(function* () {
      const user = yield* requireUser(request)
      const tasks = yield* Tasks.use(store => store.current)
      return { user, tasks }
    }),
  init,
  update,
  view,
  subscriptions,
  // Snapshots keep only this user's own state; the list comes back from the
  // Subscription after a restore.
  snapshotDeps: model => [model.filter, model.draft, model.draftError, model.notice],
  // Browser-only Commands, performed by the page after the next morph.
  clientCommands: {
    FocusNewTask: () => ({ focus: '#task-title' }),
  },
}
