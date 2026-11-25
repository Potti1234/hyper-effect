import { Effect, Match as M, Schema as S, Stream } from 'effect'
import { Command, Subscription, type Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { type Program, memoizeLast, region } from '@hyper-effect/core'
import { type Contributions, ExtensionSettings } from '@hyper-effect/jellyware'

import { Issue, statusLabel } from '#app/domain'
import { Shell, frame, loadShell, shellChanges } from '#app/extensions'
import { Workspace, type WorkspaceState } from '#app/store'
import { statusIcon } from '#app/view/icons'

export const PATH = '/triage'

export const Model = S.Struct({
  shell: Shell,
  issues: S.Array(Issue),
  pending: S.Array(S.String),
  error: S.NullOr(S.String),
  /** Whether the secret setting `inboxToken` is set; never the token. */
  inboxConnected: S.Boolean,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  ClickedTake: { issueId: S.String },
  FinishedTake: { issueId: S.String, error: S.NullOr(S.String) },
  GotIssues: { issues: S.Array(Issue) },
  GotShell: { shell: Shell },
  GotInbox: { connected: S.Boolean },
})
export type Message = typeof Message.Type
export const ClientMessage = S.Union([Message.ClickedTake])
export type ClientMessage = typeof ClientMessage.Type

type Flags = Readonly<{ shell: Shell; issues: ReadonlyArray<Issue>; inboxConnected: boolean }>

export const eligible = (issue: Issue): boolean =>
  issue.assigneeId === null && (issue.status === 'backlog' || issue.status === 'todo')

export const issuesOf = (state: WorkspaceState): ReadonlyArray<Issue> =>
  state.issues.filter(eligible).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))

export const TakeIssue = Command.define('TriageTakeIssue', {
  args: { issueId: S.String, memberId: S.String },
  messages: [Message.FinishedTake],
  execute: ({ issueId, memberId }) =>
    Workspace.use(workspace =>
      Effect.gen(function* () {
        // Re-read shared state: another member may already have taken it.
        const state = yield* workspace.current
        const issue = state.issues.find(item => item.id === issueId)
        if (!state.members.some(member => member.id === memberId)) {
          return Message.FinishedTake({ issueId, error: 'You are no longer in this workspace.' })
        }
        if (issue === undefined || !eligible(issue)) {
          return Message.FinishedTake({ issueId, error: 'This issue is no longer available for triage.' })
        }
        yield* workspace.update([{ id: issueId, patch: { assigneeId: memberId } }], memberId)
        return Message.FinishedTake({ issueId, error: null })
      }),
    ).pipe(
      Effect.catchTags({
        IssueNotFound: () => Effect.succeed(Message.FinishedTake({ issueId, error: 'This issue was deleted.' })),
        InvalidChange: ({ reason }) => Effect.succeed(Message.FinishedTake({ issueId, error: reason })),
      }),
    ),
})

export const init = (flags: Flags): Update.Return<Model, Message> => ({
  model: { ...flags, pending: [], error: null },
})

export const update = (model: Model, message: Message): Update.Return<Model, Message, Workspace> =>
  M.value(message).pipe(
    M.withReturnType<Update.Return<Model, Message, Workspace>>(),
    M.tagsExhaustive({
      ClickedTake: ({ issueId }) => {
        if (model.pending.includes(issueId) || !model.issues.some(issue => issue.id === issueId && eligible(issue))) {
          return { model }
        }
        return {
          model: { ...model, pending: [...model.pending, issueId], error: null },
          commands: [TakeIssue({ issueId, memberId: model.shell.me.id })],
        }
      },
      FinishedTake: ({ issueId, error }) => ({
        model: { ...model, pending: model.pending.filter(id => id !== issueId), error },
      }),
      GotIssues: ({ issues }) => ({ model: { ...model, issues } }),
      GotInbox: ({ connected }) => ({ model: { ...model, inboxConnected: connected } }),
      GotShell: ({ shell }) => ({ model: { ...model, shell } }),
    }),
  )

const gotIssues = memoizeLast((issues: ReadonlyArray<Issue>) => Message.GotIssues({ issues }))

export const subscriptions = Subscription.make<Model, Message, Workspace | Contributions | ExtensionSettings>()(entry => ({
  // From the version serving the page: a session moved to a new version
  // (its settings changed) hears the new value.
  inbox: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Stream.unwrap(ExtensionSettings.use(settings => Effect.succeed(Stream.succeed(Message.GotInbox({ connected: settings.hasSecret('inboxToken') }))))),
    },
  ),
  shell: entry(
    { memberId: S.String },
    {
      modelToDependencies: model => ({ memberId: model.shell.me.id }),
      dependenciesToStream: ({ memberId }) => shellChanges(memberId).pipe(Stream.map(shell => Message.GotShell({ shell }))),
    },
  ),
  issues: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Stream.unwrap(
          Workspace.use(workspace => Effect.succeed(workspace.changes.pipe(
            Stream.map(issuesOf),
            Stream.changesWith((a, b) => a.length === b.length && a.every((issue, index) => issue === b[index])),
            Stream.map(gotIssues),
          ))),
        ),
    },
  ),
}))

const issueRow = (issue: Issue, pending: boolean, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Id(`triage-issue-${issue.id}`), h.Class('flex items-center gap-3 border-b px-4 py-2')],
    [
      h.a(
        [h.Href(`/issue/${issue.identifier}`), h.Class('flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-accent')],
        [
          statusIcon(issue.status, h, 'size-3.5 shrink-0', statusLabel[issue.status]),
          h.span([h.Class('w-14 shrink-0 text-muted-foreground tabular-nums')], [issue.identifier]),
          h.span([h.Class('min-w-0 flex-1 truncate')], [issue.title]),
        ],
      ),
      h.button(
        [
          h.Type('button'),
          h.Class('shrink-0 rounded-md border px-3 py-1.5 text-[13px] hover:bg-accent disabled:opacity-50'),
          h.Disabled(pending),
          h.OnClick(Message.ClickedTake({ issueId: issue.id })),
        ],
        ['Take it'],
      ),
    ],
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: 'Triage · Linear',
  body: frame(model.shell, PATH, [
    h.header([h.Class('flex h-11 items-center gap-3 border-b px-4')], [
      h.h1([h.Class('text-[13px] font-semibold')], ['Triage']),
      h.span([h.Class('flex-1 text-[13px] text-muted-foreground')], ['Unassigned · Backlog and Todo · Newest first']),
      region(h, {
        id: 'triage-inbox',
        deps: [model.inboxConnected],
        render: () =>
          h.span([h.Id('triage-inbox'), h.Class('text-[12px] text-muted-foreground'), h.DataAttribute('connected', String(model.inboxConnected))], [
            model.inboxConnected ? 'Support inbox: token set' : 'Support inbox: no token',
          ]),
      }),
    ]),
    region(h, {
      id: 'triage-notice', deps: [model.error],
      render: () => h.div([h.Id('triage-notice'), h.Role('status')],
        model.error === null ? [] : [h.p([h.Class('px-4 py-2 text-[13px] text-destructive')], [model.error])]),
    }),
    region(h, {
      id: 'triage-list', deps: [model.issues, model.pending],
      render: () => h.div([h.Id('triage-list'), h.Class('flex-1 overflow-y-auto')],
        model.issues.length === 0
          ? [h.p([h.Class('p-4 text-[13px] text-muted-foreground')], ['No issues to triage.'])]
          : model.issues.map(issue => {
            const pending = model.pending.includes(issue.id)
            return region(h, {
              id: `triage-issue-${issue.id}`, deps: [issue, pending],
              render: () => issueRow(issue, pending, h),
            })
          })),
    }),
  ], h),
})

export const program: Program<Model, Message, ClientMessage, Flags, Workspace | Contributions | ExtensionSettings> = {
  name: 'triage',
  Model,
  ClientMessage,
  flags: request => Effect.gen(function* () {
    const shell = yield* loadShell(request)
    const state = yield* Workspace.use(workspace => workspace.current)
    const settings = yield* ExtensionSettings
    return { shell, issues: issuesOf(state), inboxConnected: settings.hasSecret('inboxToken') }
  }),
  init,
  update,
  view,
  subscriptions,
  snapshotDeps: () => [],
}
