import { Clock, Effect, Match as M, Schema as S, Stream } from 'effect'
import { Subscription, type Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import { type Program, region } from '@hyper-effect/core'
import { type Contributions, islandView } from '@hyper-effect/jellyware'

import { Activity, Issue, Member, formatDateTime } from '#app/domain'
import { Shell, frame, loadShell, shellChanges } from '#app/extensions'
import { Workspace, type WorkspaceState } from '#app/store'

import { Calendar, Day } from './contract.ts'
import { activityOn, daysOf } from './days.ts'

/* Activity: the calendar (this extension's own island) of the last
   twenty weeks, and below it what happened on the day clicked. */

export const PATH = '/activity'
const WEEKS = 20

const Data = S.Struct({
  days: S.Array(Day),
  activity: S.Array(Activity),
  issues: S.Array(Issue),
  members: S.Array(Member),
})
type Data = typeof Data.Type

export const Model = S.Struct({ shell: Shell, data: Data, selected: S.NullOr(S.String) })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  ClickedDay: { date: S.String },
  ClickedClear: {},
  GotData: { data: Data },
  GotShell: { shell: Shell },
})
export type Message = typeof Message.Type
export const ClientMessage = S.Union([Message.ClickedClear])
export type ClientMessage = typeof ClientMessage.Type

export const dataOf = (state: WorkspaceState, now: number): Data => ({
  days: daysOf(state.activity, now, WEEKS),
  activity: state.activity,
  issues: state.issues,
  members: state.members,
})

type Flags = Readonly<{ shell: Shell; data: Data }>

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  M.value(message).pipe(
    M.withReturnType<Update.Return<Model, Message>>(),
    M.tagsExhaustive({
      // From the island (a browser posts it): only a day the calendar shows.
      ClickedDay: ({ date }) =>
        model.data.days.some(day => day.date === date) ? { model: { ...model, selected: model.selected === date ? null : date } } : { model },
      ClickedClear: () => ({ model: { ...model, selected: null } }),
      GotData: ({ data }) => ({ model: { ...model, data } }),
      GotShell: ({ shell }) => ({ model: { ...model, shell } }),
    }),
  )

export const subscriptions = Subscription.make<Model, Message, Workspace | Contributions>()(entry => ({
  shell: entry(
    { memberId: S.String },
    {
      modelToDependencies: model => ({ memberId: model.shell.me.id }),
      dependenciesToStream: ({ memberId }) => shellChanges(memberId).pipe(Stream.map(shell => Message.GotShell({ shell }))),
    },
  ),
  data: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Stream.unwrap(
          Workspace.use(workspace =>
            Effect.succeed(
              workspace.changes.pipe(
                Stream.mapEffect(state => Effect.map(Clock.currentTimeMillis, now => dataOf(state, now))),
                Stream.map(data => Message.GotData({ data })),
              ),
            ),
          ),
        ),
    },
  ),
}))

const dayList = (model: Model, h: HtmlBuilder<Message>): Html => {
  const entries = model.selected === null ? [] : activityOn(model.data.activity, model.selected)
  return h.section(
    [h.Id('activity-day'), h.Class('rounded-lg border bg-card p-4')],
    model.selected === null
      ? [h.p([h.Class('text-[13px] text-muted-foreground')], ['Click a day in the calendar to see what happened.'])]
      : [
          h.div(
            [h.Class('mb-2 flex items-center gap-2')],
            [
              h.h2([h.Class('flex-1 text-[13px] font-semibold')], [`${entries.length} change${entries.length === 1 ? '' : 's'} on ${model.selected}`]),
              h.button([h.Id('activity-clear'), h.Type('button'), h.OnClick(Message.ClickedClear()), h.Class('rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-accent')], ['Clear']),
            ],
          ),
          h.ul(
            [h.Class('flex flex-col')],
            entries.slice(0, 50).map(entry => {
              const issue = model.data.issues.find(each => each.id === entry.issueId)
              const actor = model.data.members.find(each => each.id === entry.actorId)
              return h.li(
                [h.Class('flex items-baseline gap-2 py-1 text-[12.5px]')],
                [
                  h.span([h.Class('w-28 shrink-0 text-[11px] text-muted-foreground tabular-nums')], [formatDateTime(entry.at)]),
                  h.span([h.Class('min-w-0 flex-1')], [
                    h.span([h.Class('font-medium')], [actor?.name ?? 'Someone']),
                    ` ${entry.text}`,
                    ...(issue === undefined
                      ? []
                      : [' · ', h.a([h.Href(`/issue/${issue.identifier}`), h.Class('text-muted-foreground hover:underline')], [`${issue.identifier} ${issue.title}`])]),
                  ]),
                ],
              )
            }),
          ),
        ],
  )
}

export const makeProgram = (calendarSrc: string): Program<Model, Message, ClientMessage, Flags, Workspace | Contributions> => ({
  name: 'activity',
  Model,
  ClientMessage,
  flags: request =>
    Effect.gen(function* () {
      const shell = yield* loadShell(request)
      const state = yield* Workspace.use(workspace => workspace.current)
      return { shell, data: dataOf(state, yield* Clock.currentTimeMillis) }
    }),
  init: flags => ({ model: { ...flags, selected: null } }),
  update,
  view: (model, h): Document => ({
    title: 'Activity · Linear',
    body: frame(
      model.shell,
      PATH,
      [
        h.header([h.Class('flex h-11 shrink-0 items-center border-b px-4')], [h.h1([h.Class('text-[13px] font-semibold')], ['Activity'])]),
        h.div(
          [h.Class('flex-1 overflow-y-auto p-4')],
          [
            region(h, {
              id: 'activity-calendar',
              deps: [model.data.days, model.selected],
              render: () =>
                h.section(
                  [h.Id('activity-calendar'), h.Class('mb-4 rounded-lg border bg-card p-4')],
                  [
                    h.h2([h.Class('text-[13px] font-semibold')], ['The last 20 weeks']),
                    islandView(
                      Calendar,
                      {
                        id: 'activity-calendar-island',
                        src: calendarSrc,
                        label: 'Activity per day',
                        props: { days: model.data.days, selected: model.selected },
                        onEvent: event => Message.ClickedDay({ date: event.date }),
                      },
                      h,
                    ),
                  ],
                ),
            }),
            region(h, { id: 'activity-day', deps: [model.selected, model.data.activity], render: () => dayList(model, h) }),
          ],
        ),
      ],
      h,
    ),
  }),
  subscriptions,
  snapshotDeps: model => [model.selected],
})
