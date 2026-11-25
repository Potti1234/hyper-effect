import { Effect, Match as M, Schema as S, Stream } from 'effect'
import { Command, Subscription, type Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import { type Program, region } from '@hyper-effect/core'
import { type Contributions, ExtensionData } from '@hyper-effect/jellyware'

import { Issue, statusLabel } from '#app/domain'
import { Shell, frame, loadShell, shellChanges } from '#app/extensions'
import { Workspace } from '#app/store'
import { statusIcon } from '#app/view/icons'

import { pinnedChanges, pinsOf, toggle, withIssues } from './pins.ts'

/* Pinned: the issues the member looking pinned, newest first, live. */

export const PATH = '/pinned'

const PinnedIssue = S.Struct({ issue: Issue, pinnedAt: S.Number })
type PinnedIssue = typeof PinnedIssue.Type

export const Model = S.Struct({ shell: Shell, pinned: S.Array(PinnedIssue), notice: S.NullOr(S.String) })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  ClickedUnpin: { issueId: S.String },
  GotPinned: { pinned: S.Array(PinnedIssue) },
  GotShell: { shell: Shell },
  FinishedUnpin: { message: S.String },
})
export type Message = typeof Message.Type
export const ClientMessage = S.Union([Message.ClickedUnpin])
export type ClientMessage = typeof ClientMessage.Type

export const Unpin = Command.define('PinsUnpin', {
  args: { issueId: S.String, identifier: S.String, memberId: S.String },
  messages: [Message.FinishedUnpin],
  execute: ({ issueId, identifier, memberId }) =>
    ExtensionData.use(data => toggle(data, memberId, issueId, identifier)).pipe(
      Effect.catch(message => Effect.succeed(message)),
      Effect.map(message => Message.FinishedUnpin({ message })),
    ),
})

type Flags = Readonly<{ shell: Shell; pinned: ReadonlyArray<PinnedIssue> }>

export const init = (flags: Flags): Update.Return<Model, Message> => ({ model: { ...flags, notice: null } })

export const update = (model: Model, message: Message): Update.Return<Model, Message, ExtensionData> =>
  M.value(message).pipe(
    M.withReturnType<Update.Return<Model, Message, ExtensionData>>(),
    M.tagsExhaustive({
      // Posted by a browser: only an issue on this member's page.
      ClickedUnpin: ({ issueId }) => {
        const pinned = model.pinned.find(each => each.issue.id === issueId)
        return pinned === undefined
          ? { model }
          : { model, commands: [Unpin({ issueId, identifier: pinned.issue.identifier, memberId: model.shell.me.id })] }
      },
      GotPinned: ({ pinned }) => ({ model: { ...model, pinned } }),
      GotShell: ({ shell }) => ({ model: { ...model, shell } }),
      FinishedUnpin: ({ message }) => ({ model: { ...model, notice: message } }),
    }),
  )

export const subscriptions = Subscription.make<Model, Message, Workspace | Contributions | ExtensionData>()(entry => ({
  shell: entry(
    { memberId: S.String },
    {
      modelToDependencies: model => ({ memberId: model.shell.me.id }),
      dependenciesToStream: ({ memberId }) => shellChanges(memberId).pipe(Stream.map(shell => Message.GotShell({ shell }))),
    },
  ),
  pinned: entry(
    { memberId: S.String },
    {
      modelToDependencies: model => ({ memberId: model.shell.me.id }),
      dependenciesToStream: ({ memberId }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const data = yield* ExtensionData
            const workspace = yield* Workspace
            return pinnedChanges(data, workspace, memberId).pipe(Stream.map(pinned => Message.GotPinned({ pinned })))
          }),
        ),
    },
  ),
}))

const row = (pinned: PinnedIssue, h: HtmlBuilder<Message>): Html =>
  h.li(
    [h.Id(`pinned-${pinned.issue.identifier}`), h.Class('flex items-center gap-2 border-b px-4 py-2 text-[13px]')],
    [
      statusIcon(pinned.issue.status, h, 'size-3.5 shrink-0', statusLabel[pinned.issue.status]),
      h.span([h.Class('w-14 shrink-0 text-muted-foreground tabular-nums')], [pinned.issue.identifier]),
      h.a([h.Href(`/issue/${pinned.issue.identifier}`), h.Class('min-w-0 flex-1 truncate hover:underline')], [pinned.issue.title]),
      h.button(
        [
          h.Type('button'),
          h.Id(`unpin-${pinned.issue.identifier}`),
          h.Class('rounded px-2 py-0.5 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground'),
          h.OnClick(Message.ClickedUnpin({ issueId: pinned.issue.id })),
        ],
        ['Unpin'],
      ),
    ],
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: 'Pinned · Linear',
  body: frame(
    model.shell,
    PATH,
    [
      h.header(
        [h.Class('flex h-11 items-center gap-3 border-b px-4')],
        [
          h.h1([h.Class('flex-1 text-[13px] font-semibold')], ['Pinned']),
          region(h, {
            id: 'pinned-notice',
            deps: [model.notice],
            render: () => h.span([h.Id('pinned-notice'), h.Class('text-[12px] text-muted-foreground'), h.AriaLive('polite')], [model.notice ?? '']),
          }),
        ],
      ),
      region(h, {
        id: 'pinned-list',
        deps: [model.pinned],
        render: () =>
          h.ul(
            [h.Id('pinned-list'), h.Class('flex-1 overflow-y-auto')],
            model.pinned.length === 0
              ? [h.li([h.Class('p-4 text-[13px] text-muted-foreground')], ['Nothing pinned yet. Pin an issue from its page.'])]
              : model.pinned.map(pinned => row(pinned, h)),
          ),
      }),
    ],
    h,
  ),
})

export const program: Program<Model, Message, ClientMessage, Flags, Workspace | Contributions | ExtensionData> = {
  name: 'pins',
  Model,
  ClientMessage,
  flags: request =>
    Effect.gen(function* () {
      const shell = yield* loadShell(request)
      const data = yield* ExtensionData
      const state = yield* Workspace.use(workspace => workspace.current)
      return { shell, pinned: withIssues(yield* pinsOf(data, shell.me.id), state.issues) }
    }),
  init,
  update,
  view,
  subscriptions,
  snapshotDeps: () => [],
}
