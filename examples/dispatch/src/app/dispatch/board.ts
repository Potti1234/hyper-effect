import { Effect, Match as M, Option, Schema as S, Stream } from 'effect'
import { Command, Subscription } from 'foldkit'
import type { Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import * as Island from '@hyper-effect/island'
import { memoizeLast, region, shared, sampleLatest, type Program } from '@hyper-effect/core'
import { cn } from '@/lib/utils'
import { button } from '@/ui/button'
import { card, cardContent, cardHeader } from '@/ui/card'
import { empty, emptyDescription, emptyTitle } from '@/ui/empty'
import { input } from '@/ui/input'
import * as ToggleGroup from '@/ui/toggle-group'

import {
  Activity,
  Incident,
  Location,
  NewIncident,
  Severity,
  fieldErrors,
  formatTime,
  severityLabel,
} from './domain'
import { IncidentMap, IncidentMapEvent, type IncidentMapProps } from './islands/incident-map'
import { HEADER_ID, header, sectionTitle, severityBadge, statusBadge } from './layout'
import { requireUser } from './auth'
import * as Levers from './levers'
import { type DispatchState, IncidentStore, PRESENCE_SAMPLE, Presence } from './store'

/* The dispatch board. Everything here runs on the server: the list, the
   filter (a crease toggle-group Submodel), the search, the report form with
   Schema validation, live updates from other dispatchers and presence. The
   map is an island; it reports selections and picked locations as events
   and receives markers, selection and the draft pin as props. */

// MODEL

const Filter = S.Literals(['all', 'open', 'assigned', 'resolved'])
type Filter = typeof Filter.Type

const Draft = S.Struct({
  title: S.String,
  severity: Severity,
  location: S.NullOr(Location),
})
type Draft = typeof Draft.Type

const Idle = S.TaggedStruct('Idle', {})
const Reporting = S.TaggedStruct('Reporting', {})
const ReportState = S.Union([Idle, Reporting])

export const Model = S.Struct({
  me: S.String,
  version: S.String,
  incidents: S.Array(Incident),
  activity: S.Array(Activity),
  online: S.Array(S.String),
  isConnected: S.Boolean,
  filter: Filter,
  filterGroup: ToggleGroup.Model,
  query: S.String,
  selectedId: S.NullOr(S.String),
  draft: Draft,
  draftErrors: S.Record(S.String, S.String),
  reportState: ReportState,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ChangedQuery: { query: S.String },
  ClickedIncident: { id: S.String },
  ClickedTakeIncident: { id: S.String },
  ClickedResolveIncident: { id: S.String },
  ClickedReopenIncident: { id: S.String },
  ChangedDraftTitle: { title: S.String },
  SelectedDraftSeverity: { severity: Severity },
  SubmittedDraft: {},
  ClickedDiscardDraft: {},
  GotFilterGroupMessage: { message: ToggleGroup.Message },
  GotMapEvent: { event: IncidentMapEvent },
  ChangedDispatch: {
    version: S.String,
    incidents: S.Array(Incident),
    activity: S.Array(Activity),
  },
  ChangedOnline: { online: S.Array(S.String) },
  ChangedConnection: { isConnected: S.Boolean },
  SucceededReportIncident: { id: S.String },
  CompletedIncidentChange: {},
})
export type Message = typeof Message.Type

/** What a browser may post directly. Store changes, presence and Command
 *  results are server facts and cannot be forged. Typed values (query, draft
 *  title) and map events arrive through the session's handler table. */
export const ClientMessage = S.Union([
  Message.ClickedIncident,
  Message.ClickedTakeIncident,
  Message.ClickedResolveIncident,
  Message.ClickedReopenIncident,
  Message.SelectedDraftSeverity,
  Message.SubmittedDraft,
  Message.ClickedDiscardDraft,
  Message.GotFilterGroupMessage,
])
export type ClientMessage = typeof ClientMessage.Type

// COMMAND

const ReportIncident = Command.define('ReportIncident', {
  args: { title: S.String, severity: Severity, location: Location, by: S.String },
  messages: [Message.SucceededReportIncident],
  execute: ({ by, ...input }) =>
    Effect.gen(function* () {
      const store = yield* IncidentStore
      const incident = yield* store.create(input, by)
      return Message.SucceededReportIncident({ id: incident.id })
    }),
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
      // Someone else may have changed it first; the live state will show it.
      Effect.catchTag('IncidentNotFound', () =>
        Effect.succeed(Message.CompletedIncidentChange()),
      ),
    ),
})

// INIT

export type Flags = Readonly<{
  me: string
  version: string
  incidents: ReadonlyArray<Incident>
  activity: ReadonlyArray<Activity>
}>

const emptyDraft: Draft = { title: '', severity: 'medium', location: null }

export const init = (flags: Flags): Update.Return<Model, Message> => ({
  model: {
    me: flags.me,
    version: flags.version,
    incidents: flags.incidents,
    activity: flags.activity,
    online: [],
    isConnected: false,
    filter: 'all',
    filterGroup: ToggleGroup.init({ id: 'status-filter' }),
    query: '',
    selectedId: null,
    draft: emptyDraft,
    draftErrors: {},
    reportState: Idle.make({}),
  },
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message, IncidentStore>

const decodeDraft = S.decodeUnknownExit(NewIncident)

const changeStatus = (model: Model, id: string, status: 'open' | 'assigned' | 'resolved') => ({
  model,
  commands: [ChangeStatus({ id, status, by: model.me })],
})

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ChangedQuery: ({ query }) => ({ model: { ...model, query } }),
      ClickedIncident: ({ id }) => ({
        model: { ...model, selectedId: model.selectedId === id ? null : id },
      }),
      ClickedTakeIncident: ({ id }) => changeStatus(model, id, 'assigned'),
      ClickedResolveIncident: ({ id }) => changeStatus(model, id, 'resolved'),
      ClickedReopenIncident: ({ id }) => changeStatus(model, id, 'open'),
      ChangedDraftTitle: ({ title }) => ({
        model: { ...model, draft: { ...model.draft, title } },
      }),
      SelectedDraftSeverity: ({ severity }) => ({
        model: { ...model, draft: { ...model.draft, severity } },
      }),
      SubmittedDraft: () => {
        if (model.reportState._tag === 'Reporting') return { model }
        const draft = { ...model.draft, title: model.draft.title.trim() }
        const decoded = decodeDraft(draft, { errors: 'all' })
        if (decoded._tag === 'Failure') {
          const errors = Option.match(
            Option.filter(
              Option.fromNullishOr(
                decoded.cause.reasons.find(reason => reason._tag === 'Fail')?.error,
              ),
              S.isSchemaError,
            ),
            {
              onNone: () => ({ '': 'Check the form.' }),
              onSome: error => fieldErrors(error.issue),
            },
          )
          return { model: { ...model, draftErrors: errors } }
        }
        const { location, ...rest } = decoded.value
        return location === null
          ? { model }
          : {
              model: { ...model, draftErrors: {}, reportState: Reporting.make({}) },
              commands: [ReportIncident({ ...rest, location, by: model.me })],
            }
      },
      ClickedDiscardDraft: () => ({
        model: { ...model, draft: emptyDraft, draftErrors: {} },
      }),
      GotFilterGroupMessage: ({ message: groupMessage }) => {
        const next = ToggleGroup.update(model.filterGroup, groupMessage)
        const filter = Option.fromNullishOr(next.outMessage).pipe(
          Option.flatMap(out => S.decodeUnknownOption(Filter)(out.value)),
          Option.getOrElse(() => model.filter),
        )
        return {
          model: { ...model, filterGroup: next.model, filter },
          commands: Command.mapMessages(next.commands ?? [], groupMessage =>
            Message.GotFilterGroupMessage({ message: groupMessage }),
          ),
        }
      },
      GotMapEvent: ({ event }) =>
        M.value(event).pipe(
          M.withReturnType<UpdateReturn>(),
          M.tagsExhaustive({
            SelectedMarker: ({ id }) => ({ model: { ...model, selectedId: id } }),
            PickedLocation: location => ({
              model: {
                ...model,
                draft: {
                  ...model.draft,
                  location: { longitude: location.longitude, latitude: location.latitude },
                },
                draftErrors: { ...model.draftErrors, location: '' },
              },
            }),
          }),
        ),
      ChangedDispatch: ({ version, incidents, activity }) => ({
        model: { ...model, version, incidents, activity },
      }),
      ChangedOnline: ({ online }) => ({ model: { ...model, online } }),
      ChangedConnection: ({ isConnected }) => ({ model: { ...model, isConnected } }),
      SucceededReportIncident: ({ id }) => ({
        model: {
          ...model,
          draft: emptyDraft,
          draftErrors: {},
          reportState: Idle.make({}),
          selectedId: id,
          filter: model.filter === 'all' || model.filter === 'open' ? model.filter : 'all',
        },
      }),
      CompletedIncidentChange: () => ({ model }),
    }),
  )

// SUBSCRIPTION

// Every board session subscribes to the same feeds: build each Message once
// per change and share it (see `memoizeLast`).
const changedDispatch = Levers.memoizeMessages
  ? memoizeLast((state: DispatchState) => Message.ChangedDispatch(state))
  : (state: DispatchState) => Message.ChangedDispatch(state)
const changedOnline = Levers.memoizeMessages
  ? memoizeLast((online: ReadonlyArray<string>) => Message.ChangedOnline({ online }))
  : (online: ReadonlyArray<string>) => Message.ChangedOnline({ online })

export const subscriptions = Subscription.make<Model, Message, IncidentStore | Presence>()(
  entry => ({
    dispatch: entry(
      {},
      {
        modelToDependencies: () => ({}),
        dependenciesToStream: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              const store = yield* IncidentStore
              return store.changes.pipe(Stream.map(changedDispatch))
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

const SHARED_REGIONS = Levers.sharedRegions

const FILTERS: ReadonlyArray<Readonly<{ value: Filter; label: string }>> = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'resolved', label: 'Resolved' },
]

const visibleIncidents = (model: Model): ReadonlyArray<Incident> => {
  const query = model.query.trim().toLowerCase()
  return model.incidents.filter(
    incident =>
      (model.filter === 'all' || incident.status === model.filter) &&
      (query === '' ||
        incident.title.toLowerCase().includes(query) ||
        incident.id.toLowerCase().includes(query)),
  )
}

const selectedIncident = (model: Model): Incident | undefined =>
  model.incidents.find(incident => incident.id === model.selectedId)

const incidentRow = (model: Model, incident: Incident, h: HtmlBuilder<Message>): Html => {
  const isSelected = incident.id === model.selectedId
  return h.li(
    [h.Key(incident.id), h.Id(`incident-${incident.id}`)],
    [
      h.button(
        [
          h.Type('button'),
          h.Id(`row-${incident.id}`),
          h.AriaPressed(isSelected ? 'true' : 'false'),
          h.OnClick(Message.ClickedIncident({ id: incident.id })),
          h.Class(
            cn(
              'grid w-full gap-1.5 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted',
              isSelected && 'border-primary bg-muted ring-1 ring-primary',
              incident.status === 'resolved' && 'opacity-60',
            ),
          ),
        ],
        [
          h.div(
            [h.Class('flex items-center justify-between gap-2')],
            [
              h.span([h.Class('font-mono text-xs text-muted-foreground')], [incident.id]),
              h.span([h.Class('flex gap-1')], [severityBadge(incident.severity, h), statusBadge(incident.status, h)]),
            ],
          ),
          h.span([h.Class('font-medium leading-snug')], [incident.title]),
          h.span(
            [h.Class('text-xs text-muted-foreground')],
            [
              `Reported ${formatTime(incident.createdAt)}`,
              incident.assignee === null ? '' : ` · ${incident.assignee}`,
              incident.comments.length === 0 ? '' : ` · ${incident.comments.length} comments`,
            ],
          ),
        ],
      ),
    ],
  )
}

/* The incident list is three regions in a static card, so a change to one
   incident costs one row: the filter and search (a Submodel whose key
   handlers are probed on every render) re-render only when the filter does,
   the count only when it changes, and the list around the rows is cheap. */
const incidentList = (model: Model, h: HtmlBuilder<Message>): Html => {
  const incidents = visibleIncidents(model)
  return card(
    {
      class: 'min-h-0',
      children: [
        cardHeader(
          {
            children: [
              sectionTitle('Incidents', h, [
                region(h, {
                  id: 'incident-count',
                  deps: [incidents.length],
                  render: () =>
                    h.span([h.Id('incident-count'), h.Class('text-xs text-muted-foreground')], [`${incidents.length} shown`]),
                }),
              ]),
            ],
          },
          h,
        ),
        cardContent(
          {
            class: 'grid gap-3',
            children: [
              region(h, {
                id: 'incident-controls',
                deps: [model.filter, model.filterGroup, model.query],
                render: () => incidentControls(model, h),
              }),
              region(h, {
                id: 'incident-rows',
                deps: [incidents, model.selectedId],
                render: () => incidentRows(model, incidents, h),
              }),
            ],
          },
          h,
        ),
      ],
    },
    h,
  )
}

const incidentControls = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Id('incident-controls'), h.Class('grid gap-3')],
    [
      ToggleGroup.toggleGroup(
        {
          model: model.filterGroup,
          toParentMessage: message => Message.GotFilterGroupMessage({ message }),
          ariaLabel: 'Filter by status',
          value: model.filter,
          variant: 'outline',
          size: 'sm',
          items: FILTERS.map(({ value, label }) => ({ value, children: [label] })),
        },
        h,
      ),
      input(
        {
          id: 'search',
          value: model.query,
          placeholder: 'Search title or id',
          ariaLabel: 'Search incidents',
          onInput: query => Message.ChangedQuery({ query }),
        },
        h,
      ),
    ],
  )

const incidentRows = (model: Model, incidents: ReadonlyArray<Incident>, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Id('incident-rows')],
    [
      incidents.length === 0
        ? empty(
            {
              children: [
                emptyTitle({ children: ['Nothing here'] }, h),
                emptyDescription({ children: ['No incident matches the filter.'] }, h),
              ],
            },
            h,
          )
        : h.ul(
            [h.Class('grid gap-2'), h.AriaLabel('Incidents')],
            // A region per row: when one incident changes, the list renders
            // again around the rows it keeps, and only the changed row is sent.
            incidents.map(incident =>
              region(h, {
                id: `incident-${incident.id}`,
                deps: [incident, incident.id === model.selectedId],
                // The same for every dispatcher: render once per change.
                shared: SHARED_REGIONS,
                render: () => incidentRow(model, incident, h),
              }),
            ),
          ),
    ],
  )

const mapProps = (model: Model): IncidentMapProps => ({
  markers: visibleIncidents(model).map(incident => ({
    id: incident.id,
    title: incident.title,
    severity: incident.severity,
    status: incident.status,
    longitude: incident.location.longitude,
    latitude: incident.location.latitude,
  })),
  selectedId: model.selectedId,
  draft: model.draft.location,
  mode: 'pick',
})

const selectionPanel = (model: Model, h: HtmlBuilder<Message>): Html => {
  const incident = selectedIncident(model)
  if (incident === undefined) {
    return card(
      {
        id: 'selection',
        children: [
          cardContent(
            {
              children: [
                h.p(
                  [h.Class('text-sm text-muted-foreground')],
                  ['Select an incident in the list or on the map.'],
                ),
              ],
            },
            h,
          ),
        ],
      },
      h,
    )
  }
  const actions: ReadonlyArray<Html> = [
    ...(incident.status === 'open'
      ? [button({ children: ['Take it'], size: 'sm', onClick: Message.ClickedTakeIncident({ id: incident.id }) }, h)]
      : []),
    ...(incident.status !== 'resolved'
      ? [button({ children: ['Resolve'], size: 'sm', variant: 'outline', onClick: Message.ClickedResolveIncident({ id: incident.id }) }, h)]
      : [button({ children: ['Reopen'], size: 'sm', variant: 'outline', onClick: Message.ClickedReopenIncident({ id: incident.id }) }, h)]),
  ]
  return card(
    {
      id: 'selection',
      children: [
        cardHeader(
          {
            children: [
              sectionTitle(incident.id, h, [h.span([h.Class('flex gap-1')], [severityBadge(incident.severity, h), statusBadge(incident.status, h)])]),
              h.p([h.Class('text-base font-medium')], [incident.title]),
            ],
          },
          h,
        ),
        cardContent(
          {
            class: 'grid gap-3 text-sm',
            children: [
              h.p(
                [h.Class('text-muted-foreground')],
                [
                  incident.assignee === null ? 'Unassigned' : `Assigned to ${incident.assignee}`,
                  ` · ${incident.location.latitude.toFixed(4)}, ${incident.location.longitude.toFixed(4)}`,
                ],
              ),
              h.div(
                [h.Class('flex flex-wrap items-center gap-2')],
                [
                  ...actions,
                  h.a(
                    [h.Href(`/incidents/${incident.id}`), h.Class('ml-auto text-sm font-medium underline-offset-4 hover:underline')],
                    ['Open details →'],
                  ),
                ],
              ),
            ],
          },
          h,
        ),
      ],
    },
    h,
  )
}

const SEVERITIES: ReadonlyArray<Severity> = ['low', 'medium', 'high']

const reportForm = (model: Model, h: HtmlBuilder<Message>): Html => {
  const errors = model.draftErrors
  const isReporting = model.reportState._tag === 'Reporting'
  const locationError = errors['location'] ?? ''
  return card(
    {
      id: 'report',
      children: [
        cardHeader({ children: [sectionTitle('Report an incident', h)] }, h),
        cardContent(
          {
            children: [
              h.form(
                [h.Class('grid gap-3'), h.OnSubmit(Message.SubmittedDraft())],
                [
                  input(
                    {
                      id: 'draft-title',
                      label: 'What happened?',
                      value: model.draft.title,
                      placeholder: 'Pothole on Ludwigstraße',
                      isInvalid: (errors['title'] ?? '') !== '',
                      description: errors['title'] ?? 'Validated by the NewIncident Schema on the server.',
                      onInput: title => Message.ChangedDraftTitle({ title }),
                    },
                    h,
                  ),
                  h.div(
                    [h.Class('grid gap-2')],
                    [
                      h.span([h.Class('text-sm font-medium')], ['Severity']),
                      h.div(
                        [h.Class('flex gap-2'), h.Role('group'), h.AriaLabel('Severity')],
                        SEVERITIES.map(severity =>
                          button(
                            {
                              children: [severityLabel[severity]],
                              size: 'sm',
                              variant: model.draft.severity === severity ? 'default' : 'outline',
                              onClick: Message.SelectedDraftSeverity({ severity }),
                            },
                            h,
                          ),
                        ),
                      ),
                    ],
                  ),
                  h.p(
                    [h.Class(cn('text-sm', locationError === '' ? 'text-muted-foreground' : 'text-destructive'))],
                    [
                      model.draft.location === null
                        ? locationError === '' ? 'Location: click the map to place it.' : locationError
                        : `Location: ${model.draft.location.latitude.toFixed(4)}, ${model.draft.location.longitude.toFixed(4)}`,
                    ],
                  ),
                  h.div(
                    [h.Class('flex gap-2')],
                    [
                      button(
                        { children: ['Report'], type: 'submit', isLoading: isReporting, loadingContent: ['Reporting...'] },
                        h,
                      ),
                      button(
                        { children: ['Discard'], variant: 'ghost', onClick: Message.ClickedDiscardDraft() },
                        h,
                      ),
                    ],
                  ),
                ],
              ),
            ],
          },
          h,
        ),
      ],
    },
    h,
  )
}

const activityFeed = (model: Model, h: HtmlBuilder<Message>): Html =>
  card(
    {
      id: 'activity',
      children: [
        cardHeader({ children: [sectionTitle('Activity', h)] }, h),
        cardContent(
          {
            children: [
              h.ol(
                [h.Class('grid gap-1.5 text-sm'), h.AriaLabel('Activity')],
                [
                  // The same for every dispatcher: rendered once per change and
                  // reused by every page.
                  shared(h, {
                    key: 'board:activity',
                    deps: [model.activity],
                    render: () =>
                      model.activity.slice(0, 8).map(item =>
                        h.li(
                          [h.Key(String(item.id)), h.Class('flex gap-2')],
                          [
                            h.span([h.Class('font-mono text-xs leading-5 text-muted-foreground')], [formatTime(item.at)]),
                            h.span([], [item.text]),
                          ],
                        ),
                      ),
                  }),
                ],
              ),
            ],
          },
          h,
        ),
      ],
    },
    h,
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const open = model.incidents.filter(incident => incident.status === 'open').length
  return {
    title: open === 0 ? 'Dispatch' : `(${open}) Dispatch`,
    body: h.div(
      [h.Class('flex min-h-screen flex-col bg-muted/30')],
      [
        // Regions: each part re-renders, and is re-sent, only when the Model
        // fields it reads change. The frame around them never changes.
        region(h, {
          id: HEADER_ID,
          deps: [model.me, model.online],
          render: () => header({ me: model.me, online: model.online }, h),
        }),
        h.main(
          [h.Class('grid flex-1 gap-4 p-4 sm:p-6 lg:grid-cols-[minmax(320px,400px)_1fr]')],
          [
            incidentList(model, h),
            h.div(
              [h.Class('grid content-start gap-4')],
              [
                region(h, {
                  id: 'board-map',
                  deps: [model.incidents, model.filter, model.query, model.selectedId, model.draft.location],
                  render: () =>
                    Island.view(
                      IncidentMap,
                      {
                        id: 'board-map',
                        props: mapProps(model),
                        onEvent: event => Message.GotMapEvent({ event }),
                        class: 'block h-[420px]',
                      },
                      h,
                    ),
                }),
                h.div(
                  [h.Class('grid gap-4 xl:grid-cols-2')],
                  [
                    region(h, {
                      id: 'selection',
                      deps: [selectedIncident(model)],
                      render: () => selectionPanel(model, h),
                    }),
                    region(h, {
                      id: 'report',
                      deps: [model.draft, model.draftErrors, model.reportState],
                      render: () => reportForm(model, h),
                    }),
                  ],
                ),
                region(h, {
                  id: 'activity',
                  deps: [model.activity],
                  shared: SHARED_REGIONS,
                  render: () => activityFeed(model, h),
                }),
              ],
            ),
          ],
        ),
      ],
    ),
  }
}

// PROGRAM

export const program: Program<Model, Message, ClientMessage, Flags, IncidentStore | Presence> = {
  name: 'board',
  Model,
  ClientMessage,
  flags: request =>
    Effect.gen(function* () {
      const me = yield* requireUser(request)
      const store = yield* IncidentStore
      const state = yield* store.current
      return { me, ...state }
    }),
  init,
  update,
  view,
  subscriptions,
  onConnectionChange: isConnected => Message.ChangedConnection({ isConnected }),
  // Incidents, activity and presence come back from the Subscriptions after a
  // restore; only the dispatcher's own state needs a snapshot.
  ...(!Levers.snapshotOwnStateOnly
    ? {}
    : {
        snapshotDeps: (model: Model) => [
          model.selectedId,
          model.filter,
          model.filterGroup,
          model.query,
          model.draft,
          model.draftErrors,
        ],
      }),
}
