import { Effect, Match as M, Schema as S, Stream } from 'effect'
import { Subscription, type Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import { type Program, memoizeLast, region } from '@hyper-effect/core'
import type { Contributions } from '@hyper-effect/jellyware'

import { Issue, Member, statusLabel } from '../../src/app/domain.ts'
import { Shell, frame, loadShell, shellChanges } from '../../src/app/extensions.ts'
import { Workspace, type WorkspaceState } from '../../src/app/store.ts'
import { avatar, statusIcon } from '../../src/app/view/icons.ts'

/* Stand-up: per member, the issues in progress and, if shown, in review.
   Live: a change anyone makes reaches every open copy of this page. An
   extension page, framed by the app's shell (src/app/extensions.ts). */

export const PATH = '/standup'

// MODEL

export const Model = S.Struct({
  shell: Shell,
  members: S.Array(Member),
  /** Issues in progress or in review. */
  issues: S.Array(Issue),
  showReview: S.Boolean,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ClickedToggleReview: {},
  GotShell: { shell: Shell },
  GotWork: { members: S.Array(Member), issues: S.Array(Issue) },
})
export type Message = typeof Message.Type

export const ClientMessage = S.Union([Message.ClickedToggleReview])
export type ClientMessage = typeof ClientMessage.Type

// INIT

type Work = Readonly<{ members: ReadonlyArray<Member>; issues: ReadonlyArray<Issue> }>
type Flags = Readonly<{ shell: Shell }> & Work

const workOf = (state: WorkspaceState): Work => ({
  members: state.members,
  issues: state.issues.filter(issue => issue.status === 'in_progress' || issue.status === 'in_review'),
})

export const init = (flags: Flags): Update.Return<Model, Message> => ({
  model: { shell: flags.shell, members: flags.members, issues: flags.issues, showReview: true },
})

// UPDATE

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  M.value(message).pipe(
    M.withReturnType<Update.Return<Model, Message>>(),
    M.tagsExhaustive({
      ClickedToggleReview: () => ({ model: { ...model, showReview: !model.showReview } }),
      GotShell: ({ shell }) => ({ model: { ...model, shell } }),
      GotWork: ({ members, issues }) => ({ model: { ...model, members, issues } }),
    }),
  )

// SUBSCRIPTION

const sameItems = <A>(a: ReadonlyArray<A>, b: ReadonlyArray<A>) =>
  a.length === b.length && a.every((item, index) => item === b[index])

// One Message per change for every open page.
const gotWork = memoizeLast((work: Work) => Message.GotWork(work))

export const subscriptions = Subscription.make<Model, Message, Workspace | Contributions>()(entry => ({
  shell: entry(
    { memberId: S.String },
    {
      modelToDependencies: model => ({ memberId: model.shell.me.id }),
      dependenciesToStream: ({ memberId }) => shellChanges(memberId).pipe(Stream.map(shell => Message.GotShell({ shell }))),
    },
  ),
  work: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Stream.unwrap(
          Workspace.use(workspace =>
            Effect.succeed(
              workspace.changes.pipe(
                Stream.map(workOf),
                Stream.changesWith((a, b) => a.members === b.members && sameItems(a.issues, b.issues)),
                Stream.map(gotWork),
              ),
            ),
          ),
        ),
    },
  ),
}))

// VIEW

const issueRow = (issue: Issue, h: HtmlBuilder<Message>): Html =>
  h.a(
    [
      h.Href(`/issue/${issue.identifier}`),
      h.Class('flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-accent'),
    ],
    [
      statusIcon(issue.status, h, 'size-3.5 shrink-0', statusLabel[issue.status]),
      h.span([h.Class('w-14 shrink-0 text-muted-foreground tabular-nums')], [issue.identifier]),
      h.span([h.Class('min-w-0 flex-1 truncate')], [issue.title]),
    ],
  )

const memberCard = (member: Member, issues: ReadonlyArray<Issue>, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Id(`standup-${member.id}`), h.Class('rounded-lg border bg-card p-3')],
    [
      h.div(
        [h.Class('mb-2 flex items-center gap-2')],
        [
          avatar(member, h, 'md'),
          h.h2([h.Class('flex-1 text-[13px] font-semibold')], [member.name]),
          h.span([h.Class('text-[11px] text-muted-foreground tabular-nums')], [String(issues.length)]),
        ],
      ),
      issues.length === 0
        ? h.p([h.Class('px-2 py-1.5 text-[13px] text-muted-foreground')], ['Nothing in flight.'])
        : h.div([h.Class('flex flex-col')], issues.map(issue => issueRow(issue, h))),
    ],
  )

const board = (model: Model, h: HtmlBuilder<Message>): Html => {
  const shown = model.issues.filter(issue => model.showReview || issue.status === 'in_progress')
  return h.div(
    [h.Id('standup-board'), h.Class('grid gap-3 overflow-y-auto p-4 sm:grid-cols-2 xl:grid-cols-3')],
    model.members.map(member =>
      memberCard(
        member,
        shown.filter(issue => issue.assigneeId === member.id),
        h,
      ),
    ),
  )
}

const header = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.header(
    [h.Id('standup-header'), h.Class('flex h-11 items-center gap-3 border-b px-4')],
    [
      h.h1([h.Class('flex-1 text-[13px] font-semibold')], ['Stand-up']),
      h.label(
        [h.Class('flex items-center gap-2 text-[13px] text-muted-foreground')],
        [
          h.input([
            h.Id('standup-show-review'),
            h.Type('checkbox'),
            h.Checked(model.showReview),
            h.OnClick(Message.ClickedToggleReview()),
          ]),
          'Show in review',
        ],
      ),
    ],
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: 'Stand-up · Linear',
  body: frame(
    model.shell,
    PATH,
    [
      region(h, { id: 'standup-header', deps: [model.showReview], render: () => header(model, h) }),
      region(h, {
        id: 'standup-board',
        deps: [model.members, model.issues, model.showReview],
        render: () => board(model, h),
      }),
    ],
    h,
  ),
})

export const program: Program<Model, Message, ClientMessage, Flags, Workspace | Contributions> = {
  name: 'standup',
  Model,
  ClientMessage,
  flags: request =>
    Effect.gen(function* () {
      const shell = yield* loadShell(request)
      const state = yield* Workspace.use(workspace => workspace.current)
      return { shell, ...workOf(state) }
    }),
  init,
  update,
  view,
  subscriptions,
  snapshotDeps: model => [model.showReview],
}
