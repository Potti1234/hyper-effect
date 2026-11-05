import { Effect, Match as M, Option, Schema as S, Stream } from 'effect'
import { Command, Subscription } from 'foldkit'
import type { Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import * as Island from '@hyper-effect/island'
import { PageNotFound, memoizeLast, region, sampleLatest, type Program } from '@hyper-effect/core'
import { button } from '@/ui/button'
import { card, cardContent, cardHeader } from '@/ui/card'
import { textarea } from '@/ui/textarea'

import { CommentText, Incident, formatTime } from './domain'
import { IncidentMap } from './islands/incident-map'
import { HEADER_ID, header, sectionTitle, severityBadge, statusBadge } from './layout'
import { requireUser } from './auth'
import * as Levers from './levers'
import { IncidentStore, PRESENCE_SAMPLE, Presence } from './store'

/* One incident: its comment thread (live across every open page), status
   actions, and the map island in read-only mode. The page is a second
   program at its own path; its Flags load the incident and answer 404 for an
   unknown id. */

// MODEL

const Idle = S.TaggedStruct('Idle', {})
const Posting = S.TaggedStruct('Posting', {})

export const Model = S.Struct({
  me: S.String,
  incident: Incident,
  online: S.Array(S.String),
  isConnected: S.Boolean,
  comment: S.String,
  commentError: S.NullOr(S.String),
  postState: S.Union([Idle, Posting]),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ChangedComment: { text: S.String },
  SubmittedComment: {},
  ClickedTakeIncident: {},
  ClickedResolveIncident: {},
  ClickedReopenIncident: {},
  ChangedIncident: { incident: Incident },
  ChangedOnline: { online: S.Array(S.String) },
  ChangedConnection: { isConnected: S.Boolean },
  SucceededPostComment: {},
  CompletedIncidentChange: {},
})
export type Message = typeof Message.Type

export const ClientMessage = S.Union([
  Message.SubmittedComment,
  Message.ClickedTakeIncident,
  Message.ClickedResolveIncident,
  Message.ClickedReopenIncident,
])
export type ClientMessage = typeof ClientMessage.Type

// COMMAND

const PostComment = Command.define('PostComment', {
  args: { id: S.String, text: S.String, by: S.String },
  messages: [Message.SucceededPostComment],
  execute: ({ id, text, by }) =>
    Effect.gen(function* () {
      const store = yield* IncidentStore
      yield* store.comment(id, text, by)
      return Message.SucceededPostComment()
    }).pipe(
      Effect.catchTag('IncidentNotFound', () => Effect.succeed(Message.SucceededPostComment())),
    ),
})

const ChangeStatus = Command.define('ChangeStatus', {
  args: { id: S.String, status: S.Literals(['open', 'assigned', 'resolved']), by: S.String },
  messages: [Message.CompletedIncidentChange],
  execute: ({ id, status, by }) =>
    Effect.gen(function* () {
      const store = yield* IncidentStore
      yield* store.setStatus(id, status, by)
      return Message.CompletedIncidentChange()
    }).pipe(
      Effect.catchTag('IncidentNotFound', () => Effect.succeed(Message.CompletedIncidentChange())),
    ),
})

// INIT

export type Flags = Readonly<{ me: string; incident: Incident }>

export const init = (flags: Flags): Update.Return<Model, Message> => ({
  model: {
    me: flags.me,
    incident: flags.incident,
    online: [],
    isConnected: false,
    comment: '',
    commentError: null,
    postState: Idle.make({}),
  },
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message, IncidentStore>

const decodeComment = S.decodeUnknownOption(CommentText)

const changeStatus = (model: Model, status: 'open' | 'assigned' | 'resolved') => ({
  model,
  commands: [ChangeStatus({ id: model.incident.id, status, by: model.me })],
})

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ChangedComment: ({ text }) => ({ model: { ...model, comment: text, commentError: null } }),
      SubmittedComment: () => {
        if (model.postState._tag === 'Posting') return { model }
        return Option.match(decodeComment(model.comment.trim()), {
          onNone: () => ({ model: { ...model, commentError: 'Write something first.' } }),
          onSome: text => ({
            model: { ...model, postState: Posting.make({}) },
            commands: [PostComment({ id: model.incident.id, text, by: model.me })],
          }),
        })
      },
      ClickedTakeIncident: () => changeStatus(model, 'assigned'),
      ClickedResolveIncident: () => changeStatus(model, 'resolved'),
      ClickedReopenIncident: () => changeStatus(model, 'open'),
      ChangedIncident: ({ incident }) => ({ model: { ...model, incident } }),
      ChangedOnline: ({ online }) => ({ model: { ...model, online } }),
      ChangedConnection: ({ isConnected }) => ({ model: { ...model, isConnected } }),
      SucceededPostComment: () => ({
        model: { ...model, comment: '', commentError: null, postState: Idle.make({}) },
      }),
      CompletedIncidentChange: () => ({ model }),
    }),
  )

// SUBSCRIPTION

// Every page of an incident sees the same changes: build each Message once
// and share it (see `memoizeLast`).
const changedIncident = Levers.memoizeMessages
  ? memoizeLast((incident: Incident) => Message.ChangedIncident({ incident }))
  : (incident: Incident) => Message.ChangedIncident({ incident })
const changedOnline = Levers.memoizeMessages
  ? memoizeLast((online: ReadonlyArray<string>) => Message.ChangedOnline({ online }))
  : (online: ReadonlyArray<string>) => Message.ChangedOnline({ online })

export const subscriptions = Subscription.make<Model, Message, IncidentStore | Presence>()(
  entry => ({
    incident: entry(
      { id: S.String },
      {
        modelToDependencies: model => ({ id: model.incident.id }),
        dependenciesToStream: ({ id }) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const store = yield* IncidentStore
              return store.changes.pipe(
                Stream.map(state => state.incidents.find(incident => incident.id === id)),
                Stream.filter((incident): incident is Incident => incident !== undefined),
                // The store replaces only the incident that changed.
                Stream.changesWith((previous: Incident, next: Incident) => previous === next),
                Stream.map(changedIncident),
              )
            }),
          ),
      },
    ),
    // On duty while the page is open: joining is scoped to this stream, which
    // stops when the connection closes.
    presence: entry(
      { me: S.String, isConnected: S.Boolean },
      {
        modelToDependencies: model => ({ me: model.me, isConnected: model.isConnected }),
        dependenciesToStream: ({ me, isConnected }) =>
          !isConnected
            ? Stream.empty
            : Stream.unwrap(
            Effect.gen(function* () {
              const presence = yield* Presence
              yield* presence.join(me)
              return presence.online.pipe(
                // A burst of joins (a shift starting) costs a few renders, not one each.
                sampleLatest(PRESENCE_SAMPLE),
                Stream.map(changedOnline),
              )
            }),
          ),
      },
    ),
  }),
)

// VIEW

const comments = (model: Model, h: HtmlBuilder<Message>): Html =>
  model.incident.comments.length === 0
    ? h.p([h.Class('text-sm text-muted-foreground')], ['No comments yet. Open this page in a second window and watch comments arrive.'])
    : h.ol(
        [h.Class('grid gap-3'), h.AriaLabel('Comments')],
        model.incident.comments.map((comment, index) =>
          h.li(
            [h.Key(String(index)), h.Class('grid gap-1 rounded-lg bg-muted/60 px-3 py-2 text-sm')],
            [
              h.span(
                [h.Class('flex justify-between text-xs text-muted-foreground')],
                [h.span([h.Class('font-medium text-foreground')], [comment.author]), formatTime(comment.at)],
              ),
              h.p([h.Class('whitespace-pre-wrap')], [comment.text]),
            ],
          ),
        ),
      )

const commentForm = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.form(
    [h.Class('grid gap-3'), h.OnSubmit(Message.SubmittedComment())],
    [
      textarea(
        {
          id: 'comment',
          label: `Comment as ${model.me}`,
          value: model.comment,
          rows: 3,
          placeholder: 'Crew on site, ETA 10 minutes…',
          isInvalid: model.commentError !== null,
          ...(model.commentError === null ? {} : { description: model.commentError }),
          onInput: text => Message.ChangedComment({ text }),
        },
        h,
      ),
      h.div(
        [h.Class('flex justify-end')],
        [
          button(
            {
              children: ['Post comment'],
              type: 'submit',
              isLoading: model.postState._tag === 'Posting',
              loadingContent: ['Posting...'],
            },
            h,
          ),
        ],
      ),
    ],
  )

const actions = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const { status } = model.incident
  return [
    ...(status === 'open'
      ? [button({ children: ['Take it'], size: 'sm', onClick: Message.ClickedTakeIncident() }, h)]
      : []),
    status === 'resolved'
      ? button({ children: ['Reopen'], size: 'sm', variant: 'outline', onClick: Message.ClickedReopenIncident() }, h)
      : button({ children: ['Resolve'], size: 'sm', variant: 'outline', onClick: Message.ClickedResolveIncident() }, h),
  ]
}

const details = (model: Model, h: HtmlBuilder<Message>): Html => {
  const { incident } = model
  return h.div(
    [h.Id('incident-details'), h.Class('grid gap-2')],
    [
      h.div(
        [h.Class('flex flex-wrap items-center gap-2')],
        [
          h.span([h.Class('font-mono text-sm text-muted-foreground')], [incident.id]),
          severityBadge(incident.severity, h),
          statusBadge(incident.status, h),
        ],
      ),
      h.h1([h.Class('text-2xl font-semibold tracking-tight')], [incident.title]),
      h.p(
        [h.Class('text-sm text-muted-foreground')],
        [
          `Reported ${formatTime(incident.createdAt)} · `,
          incident.assignee === null ? 'Unassigned' : `Assigned to ${incident.assignee}`,
        ],
      ),
      h.div([h.Class('flex gap-2')], actions(model, h)),
    ],
  )
}

const commentsCard = (model: Model, h: HtmlBuilder<Message>): Html =>
  card(
    {
      id: 'comments',
      children: [
        cardHeader({ children: [sectionTitle('Comments', h, [h.span([h.Class('text-xs text-muted-foreground')], [String(model.incident.comments.length)])])] }, h),
        cardContent({ class: 'grid gap-4', children: [comments(model, h), commentForm(model, h)] }, h),
      ],
    },
    h,
  )

const incidentMap = (incident: Incident, h: HtmlBuilder<Message>): Html =>
  Island.view(
    IncidentMap,
    {
      id: 'incident-map',
      props: {
        markers: [
          {
            id: incident.id,
            title: incident.title,
            severity: incident.severity,
            status: incident.status,
            longitude: incident.location.longitude,
            latitude: incident.location.latitude,
          },
        ],
        selectedId: incident.id,
        draft: null,
        mode: 'view',
      },
      // Read-only: there is nothing to report back.
      onEvent: () => Message.CompletedIncidentChange(),
      class: 'block h-[360px] lg:sticky lg:top-6',
    },
    h,
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const { incident } = model
  return {
    title: `${incident.id} · Dispatch`,
    body: h.div(
      [h.Class('flex min-h-screen flex-col bg-muted/30')],
      [
        // Regions: each part re-renders, and is re-sent, only when the Model
        // fields it reads change.
        region(h, {
          id: HEADER_ID,
          deps: [model.me, model.online],
          render: () => header({ me: model.me, online: model.online }, h),
        }),
        h.main(
          [h.Class('mx-auto grid w-full max-w-5xl gap-4 p-4 sm:p-6 lg:grid-cols-[1fr_340px]')],
          [
            h.div(
              [h.Class('grid content-start gap-4')],
              [
                h.a([h.Href('/'), h.Class('text-sm text-muted-foreground hover:text-foreground')], ['← Board']),
                region(h, { id: 'incident-details', deps: [incident], render: () => details(model, h) }),
                region(h, {
                  id: 'comments',
                  deps: [incident.comments, model.me, model.comment, model.commentError, model.postState],
                  render: () => commentsCard(model, h),
                }),
              ],
            ),
            region(h, { id: 'incident-map', deps: [incident], render: () => incidentMap(incident, h) }),
          ],
        ),
      ],
    ),
  }
}

// PROGRAM

export const program: Program<Model, Message, ClientMessage, Flags, IncidentStore | Presence> = {
  name: 'incident',
  Model,
  ClientMessage,
  flags: request =>
    Effect.gen(function* () {
      const me = yield* requireUser(request)
      const store = yield* IncidentStore
      const incident = yield* store
        .find(request.params['id'] ?? '')
        .pipe(Effect.mapError(() => new PageNotFound()))
      return { me, incident }
    }),
  init,
  update,
  view,
  subscriptions,
  onConnectionChange: isConnected => Message.ChangedConnection({ isConnected }),
  // The incident and presence come back from the Subscriptions after a
  // restore; only the comment being written is this page's own.
  ...(Levers.snapshotOwnStateOnly ? { snapshotDeps: (model: Model) => [model.comment, model.commentError] } : {}),
}
