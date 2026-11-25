import { Clock, Effect, Match as M, Schema as S, Stream } from 'effect'
import { Subscription, type Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { type Program, region } from '@hyper-effect/core'
import type { Contributions } from '@hyper-effect/jellyware'
import { Issue, formatDate } from '#app/domain'
import { Shell, frame, loadShell, shellChanges } from '#app/extensions'
import { Workspace, type WorkspaceState } from '#app/store'
import { chart as chartWidget } from '#app/widgets/chart'

export const PATH = '/progress'
const DAY = 86_400_000
const Team = S.Literals(['all', 'ENG', 'DES'])
const Mode = S.Literals(['daily', 'cumulative'])
const Completion = S.Struct({ issue: Issue, at: S.Number, estimated: S.Boolean })
type Completion = typeof Completion.Type
const Data = S.Struct({ completions: S.Array(Completion), today: S.Number })
type Data = typeof Data.Type

export const Model = S.Struct({
  shell: Shell,
  data: Data,
  days: S.Number,
  team: Team,
  mode: Mode,
  /** The day clicked in the chart (yyyy-mm-dd): the list shows its tickets. */
  day: S.NullOr(S.String).pipe(S.withDecodingDefaultKey(Effect.succeed(null))),
})
export type Model = typeof Model.Type
export const Message = defineMessageUnion({
  SelectedRange: { days: S.Number },
  SelectedTeam: { team: Team },
  SelectedMode: { mode: Mode },
  ClickedDay: { day: S.String },
  ClickedAllDays: {},
  GotData: { data: Data },
  GotShell: { shell: Shell },
})
export type Message = typeof Message.Type
export const ClientMessage = S.Union([Message.SelectedRange, Message.SelectedTeam, Message.SelectedMode, Message.ClickedAllDays])
type ClientMessage = typeof ClientMessage.Type
type Flags = Readonly<{ shell: Shell; data: Data; days: number }>

// The activity timestamp is stable even when a finished ticket is edited later.
// Count each currently done ticket once, at its most recent transition to Done.
export const dataOf = (state: WorkspaceState, now: number): Data => {
  const latest = new Map<string, number>()
  for (const entry of state.activity) {
    if (entry.kind === 'status' && entry.text.endsWith(' to Done')) {
      latest.set(entry.issueId, Math.max(latest.get(entry.issueId) ?? -Infinity, entry.at))
    }
  }
  return {
    today: Math.floor(now / DAY) * DAY,
    completions: state.issues.filter(issue => issue.status === 'done').map(issue => ({
      issue,
      at: latest.get(issue.id) ?? issue.updatedAt,
      estimated: !latest.has(issue.id),
    })),
  }
}

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  M.value(message).pipe(
    M.withReturnType<Update.Return<Model, Message>>(),
    M.tagsExhaustive({
      SelectedRange: ({ days }) => Number.isInteger(days) && days >= 7 && days <= 180
        ? { model: { ...model, days, day: null } } : { model },
      SelectedTeam: ({ team }) => ({ model: { ...model, team } }),
      // From the chart (a browser posts it): only a day the chart shows.
      ClickedDay: ({ day }) => seriesOf(model).points.some(point => isoDay(point.at) === day)
        ? { model: { ...model, day: model.day === day ? null : day } } : { model },
      ClickedAllDays: () => ({ model: { ...model, day: null } }),
      SelectedMode: ({ mode }) => ({ model: { ...model, mode } }),
      GotData: ({ data }) => ({ model: { ...model, data } }),
      GotShell: ({ shell }) => ({ model: { ...model, shell } }),
    }),
  )

export const subscriptions = Subscription.make<Model, Message, Workspace | Contributions>()(entry => ({
  shell: entry({ memberId: S.String }, {
    modelToDependencies: model => ({ memberId: model.shell.me.id }),
    dependenciesToStream: ({ memberId }) => shellChanges(memberId).pipe(Stream.map(shell => Message.GotShell({ shell }))),
  }),
  data: entry({}, {
    modelToDependencies: () => ({}),
    dependenciesToStream: () => Stream.unwrap(Workspace.use(workspace => Effect.succeed(
      // Refresh at midnight too, even when nobody edits a ticket.
      Stream.merge(workspace.changes, Stream.tick('1 minute').pipe(Stream.mapEffect(() => workspace.current))).pipe(
        Stream.mapEffect(state => Clock.currentTimeMillis.pipe(Effect.map(now => dataOf(state, now)))),
        Stream.map(data => Message.GotData({ data })),
      ),
    ))),
  }),
}))

const isoDay = (at: number) => new Date(at).toISOString().slice(0, 10)

const TEAMS = [{ id: 'ENG', label: 'Engineering' }, { id: 'DES', label: 'Design' }] as const

/** Per team shown, completions per day (or the running total). */
export const teamSeries = (model: Model) => {
  const { start, completions } = seriesOf(model)
  return TEAMS.filter(team => model.team === 'all' || model.team === team.id).map(team => {
    const counts = Array.from({ length: model.days }, () => 0)
    for (const item of completions) {
      if (item.issue.team !== team.id) continue
      const index = Math.floor((item.at - start) / DAY)
      counts[index] = (counts[index] ?? 0) + 1
    }
    let total = 0
    return {
      id: team.id,
      label: team.label,
      values: counts.map(count => (model.mode === 'daily' ? count : (total += count))),
    }
  })
}

export const seriesOf = (model: Model) => {
  const start = model.data.today - (model.days - 1) * DAY
  const end = model.data.today + DAY
  const completions = model.data.completions.filter(item =>
    (model.team === 'all' || item.issue.team === model.team) && item.at >= start && item.at < end,
  ).sort((a, b) => b.at - a.at || a.issue.identifier.localeCompare(b.issue.identifier))
  const counts = Array.from({ length: model.days }, () => 0)
  for (const item of completions) {
    const index = Math.floor((item.at - start) / DAY)
    counts[index] = (counts[index] ?? 0) + 1
  }
  let total = 0
  const points = counts.map((count, index) => {
    total += count
    return { at: start + index * DAY, count, value: model.mode === 'daily' ? count : total }
  })
  return { start, completions, points }
}

const button = (h: HtmlBuilder<Message>, label: string, selected: boolean, message: Message): Html =>
  h.button([
    h.Type('button'), h.OnClick(message), h.AriaPressed(selected ? 'true' : 'false'),
    h.Class(selected ? 'rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium' : 'rounded-md px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-accent'),
  ], [label])

const controls = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div([h.Id('progress-controls'), h.Class('flex flex-wrap items-center gap-3 border-b px-4 py-3')], [
    h.div([h.Role('group'), h.AriaLabel('Time range'), h.Class('flex items-center gap-1')],
      [...new Set([7, 30, 90, model.days])].sort((a, b) => a - b).map(days =>
        button(h, `${days} days`, model.days === days, Message.SelectedRange({ days })))),
    h.div([h.Role('group'), h.AriaLabel('Team'), h.Class('flex items-center gap-1')], [
      button(h, 'All teams', model.team === 'all', Message.SelectedTeam({ team: 'all' })),
      button(h, 'Engineering', model.team === 'ENG', Message.SelectedTeam({ team: 'ENG' })),
      button(h, 'Design', model.team === 'DES', Message.SelectedTeam({ team: 'DES' })),
    ]),
    h.div([h.Role('group'), h.AriaLabel('Chart type'), h.Class('flex items-center gap-1')], [
      button(h, 'Cumulative', model.mode === 'cumulative', Message.SelectedMode({ mode: 'cumulative' })),
      button(h, 'Daily', model.mode === 'daily', Message.SelectedMode({ mode: 'daily' })),
    ]),
  ])

const chart = (model: Model, h: HtmlBuilder<Message>): Html => {
  const { points, completions, start } = seriesOf(model)
  const estimated = completions.filter(item => item.estimated).length
  const listed = model.day === null ? completions : completions.filter(item => isoDay(item.at) === model.day)
  return h.div([h.Id('progress-content'), h.Class('flex-1 overflow-y-auto p-4')], [
    h.section([h.Class('rounded-lg border bg-card p-4')], [
      h.div([h.Class('mb-4 flex flex-wrap items-center justify-between gap-3')], [
        h.div([], [
          h.h2([h.Class('text-[13px] font-semibold')], ['Completed tickets']),
          h.p([h.Class('text-[11px] text-muted-foreground')], [`${formatDate(start)} – ${formatDate(model.data.today)} · UTC · ${model.mode === 'daily' ? 'Tickets per day' : 'Running total within selected range'} · click a day for its tickets`]),
        ]),
        h.div([h.Class('text-2xl font-semibold tabular-nums')], [String(completions.length)]),
      ]),
      completions.length === 0
        ? h.p([h.Class('py-8 text-center text-[13px] text-muted-foreground')], ['No completed tickets in this time range. Try a longer range or another team.'])
        : chartWidget({
          id: 'progress-chart',
          kind: model.mode === 'daily' ? 'bar' : 'area',
          stacked: true,
          label: model.mode === 'daily' ? 'Completed tickets per day' : 'Completed tickets, running total',
          x: points.map(point => isoDay(point.at)),
          series: teamSeries(model),
          unit: 'tickets',
          height: 260,
          onClick: point => Message.ClickedDay({ day: point.x }),
        }, h),
      h.p([h.Class('mt-4 text-[11px] text-muted-foreground')], [
        'Counts currently Done tickets once at their latest completion. Canceled and reopened tickets are excluded. Updates live.',
        ...(estimated > 0 ? [` ${estimated} ticket(s) lack completion activity; their last-updated dates are estimates.`] : []),
      ]),
    ]),
    h.section([h.Id('progress-list'), h.Class('mt-4 rounded-lg border bg-card p-4')], [
      h.div([h.Class('mb-2 flex items-center gap-2')], [
        h.h2([h.Class('flex-1 text-[13px] font-semibold')], [model.day === null ? 'Recently completed' : `Completed on ${formatDate(Date.parse(model.day))}`]),
        ...(model.day === null ? [] : [h.button([h.Id('progress-all-days'), h.Type('button'), h.OnClick(Message.ClickedAllDays()), h.Class('rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-accent')], ['All days'])]),
      ]),
      ...listed.slice(0, 20).map(item => h.a([
        h.Href(`/issue/${item.issue.identifier}`), h.Class('flex items-center gap-3 rounded-md px-2 py-1.5 text-[13px] hover:bg-accent'),
      ], [
        h.span([h.Class('shrink-0 text-muted-foreground')], [item.issue.identifier]),
        h.span([h.Class('min-w-0 flex-1 truncate')], [item.issue.title]),
        h.span([h.Class('shrink-0 text-[11px] text-muted-foreground')], [`${formatDate(item.at)}${item.estimated ? ' (estimated)' : ''}`]),
      ])),
      ...(listed.length === 0 ? [h.p([h.Class('text-[13px] text-muted-foreground')], ['No tickets to show.'])] : []),
      ...(listed.length > 20 ? [h.p([h.Class('mt-2 text-[11px] text-muted-foreground')], [`Showing the most recent 20 of ${listed.length} tickets.`])] : []),
    ]),
  ])
}

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: 'Progress · Linear',
  body: frame(model.shell, PATH, [
    h.header([h.Class('flex h-11 shrink-0 items-center border-b px-4')], [h.h1([h.Class('text-[13px] font-semibold')], ['Progress'])]),
    region(h, { id: 'progress-controls', deps: [model.days, model.team, model.mode], render: () => controls(model, h) }),
    region(h, { id: 'progress-content', deps: [model.data, model.days, model.team, model.mode, model.day], render: () => chart(model, h) }),
  ], h),
})

export const makeProgram = (defaultDays: number): Program<Model, Message, ClientMessage, Flags, Workspace | Contributions> => ({
  name: 'progress', Model, ClientMessage,
  flags: request => Effect.gen(function* () {
    const shell = yield* loadShell(request)
    const state = yield* Workspace.use(workspace => workspace.current)
    const now = yield* Clock.currentTimeMillis
    return { shell, data: dataOf(state, now), days: defaultDays }
  }),
  init: flags => ({ model: { shell: flags.shell, data: flags.data, days: flags.days, team: 'all', mode: 'cumulative', day: null } }),
  update, view, subscriptions,
  snapshotDeps: model => [model.days, model.team, model.mode, model.day],
})
