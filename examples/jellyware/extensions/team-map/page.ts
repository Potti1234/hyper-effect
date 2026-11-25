import { Effect, Match as M, Schema as S, Stream } from 'effect'
import { Command, Subscription, type Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import { type Program, region } from '@hyper-effect/core'
import { type Contributions, ExtensionData } from '@hyper-effect/jellyware'

import { Shell, frame, loadShell, shellChanges } from '#app/extensions'
import { Workspace } from '#app/store'
import { map } from '#app/widgets/map'

import { City, cityChanges, citiesOf, moveTo, openIn, placesOf } from './places.ts'

/* Team map: every city the team works in, as a marker with the number of
   people there; its tooltip names them and their open issues. A click on a
   city lists its people with their open issues. "Move my marker" lets the
   member looking pick a new place on the map. */

export const PATH = '/team-map'

export const Model = S.Struct({
  shell: Shell,
  cities: S.Array(City),
  selected: S.NullOr(S.String),
  /** Whether the next click on the map moves the member's marker. */
  moving: S.Boolean,
  notice: S.NullOr(S.String),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  ClickedCity: { name: S.String },
  ClickedMove: {},
  PickedLocation: { longitude: S.Number, latitude: S.Number },
  GotCities: { cities: S.Array(City) },
  GotShell: { shell: Shell },
  FinishedMove: { message: S.String },
})
export type Message = typeof Message.Type
export const ClientMessage = S.Union([Message.ClickedMove])
export type ClientMessage = typeof ClientMessage.Type

export const Move = Command.define('TeamMapMove', {
  args: { memberId: S.String, longitude: S.Number, latitude: S.Number },
  messages: [Message.FinishedMove],
  execute: ({ memberId, longitude, latitude }) =>
    ExtensionData.use(data => moveTo(data, memberId, longitude, latitude)).pipe(
      Effect.as('Moved your marker.'),
      Effect.catch(message => Effect.succeed(message)),
      Effect.map(message => Message.FinishedMove({ message })),
    ),
})

type Flags = Readonly<{ shell: Shell; cities: ReadonlyArray<City> }>

export const init = (flags: Flags): Update.Return<Model, Message> => ({
  model: { ...flags, selected: null, moving: false, notice: null },
})

const inRange = (longitude: number, latitude: number) =>
  Number.isFinite(longitude) && Number.isFinite(latitude) && Math.abs(longitude) <= 180 && Math.abs(latitude) <= 85

export const update = (model: Model, message: Message): Update.Return<Model, Message, ExtensionData> =>
  M.value(message).pipe(
    M.withReturnType<Update.Return<Model, Message, ExtensionData>>(),
    M.tagsExhaustive({
      // From the map (a browser posts these): only a city it shows, and a
      // location only while moving.
      ClickedCity: ({ name }) =>
        model.cities.some(city => city.name === name) ? { model: { ...model, selected: model.selected === name ? null : name } } : { model },
      ClickedMove: () => ({ model: { ...model, moving: !model.moving, notice: model.moving ? null : 'Click on the map where you work.' } }),
      PickedLocation: ({ longitude, latitude }) =>
        model.moving && inRange(longitude, latitude)
          ? { model: { ...model, moving: false, notice: 'Moving…' }, commands: [Move({ memberId: model.shell.me.id, longitude, latitude })] }
          : { model },
      GotCities: ({ cities }) => ({
        model: { ...model, cities, selected: cities.some(city => city.name === model.selected) ? model.selected : null },
      }),
      GotShell: ({ shell }) => ({ model: { ...model, shell } }),
      FinishedMove: ({ message }) => ({ model: { ...model, notice: message } }),
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
  cities: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            const data = yield* ExtensionData
            const workspace = yield* Workspace
            return cityChanges(data, workspace).pipe(Stream.map(cities => Message.GotCities({ cities })))
          }),
        ),
    },
  ),
}))

const tone = (city: City) => (openIn(city) >= 6 ? 'warning' : openIn(city) === 0 ? 'neutral' : 'info')

const cityMap = (model: Model, h: HtmlBuilder<Message>): Html =>
  map(
    {
      id: 'team-map-map',
      label: 'Where the team works',
      height: 420,
      selectedId: model.selected,
      places: model.cities.map(city => ({
        id: city.name,
        longitude: city.longitude,
        latitude: city.latitude,
        badge: String(city.people.length),
        title: city.name,
        details: [...city.people.map(person => `${person.name}: ${person.open.length} open`)],
        tone: tone(city),
      })),
      onClickPlace: name => Message.ClickedCity({ name }),
      ...(model.moving ? { onPick: location => Message.PickedLocation(location) } : {}),
    },
    h,
  )

const cityDetails = (model: Model, h: HtmlBuilder<Message>): Html => {
  const city = model.cities.find(each => each.name === model.selected)
  return h.section(
    [h.Id('team-map-city'), h.Class('rounded-lg border bg-card p-4')],
    city === undefined
      ? [h.p([h.Class('text-[13px] text-muted-foreground')], ['Click a city on the map to see who works there and on what.'])]
      : [
          h.h2([h.Class('mb-2 text-[13px] font-semibold')], [`${city.name} · ${city.people.length} ${city.people.length === 1 ? 'person' : 'people'}, ${openIn(city)} open issues`]),
          h.ul(
            [h.Class('flex flex-col gap-3')],
            city.people.map(person =>
              h.li(
                [h.Id(`team-map-person-${person.id}`)],
                [
                  h.p([h.Class('text-[13px] font-medium')], [person.name]),
                  person.open.length === 0
                    ? h.p([h.Class('text-[12px] text-muted-foreground')], ['No open issues.'])
                    : h.ul(
                        [h.Class('mt-1 flex flex-col')],
                        person.open.map(issue =>
                          h.li(
                            [],
                            [
                              h.a(
                                [h.Href(`/issue/${issue.identifier}`), h.Class('flex gap-2 rounded px-1 py-0.5 text-[12.5px] hover:bg-accent')],
                                [h.span([h.Class('w-14 shrink-0 text-muted-foreground tabular-nums')], [issue.identifier]), h.span([h.Class('truncate')], [issue.title])],
                              ),
                            ],
                          ),
                        ),
                      ),
                ],
              ),
            ),
          ),
        ],
  )
}

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: 'Team map · Linear',
  body: frame(
    model.shell,
    PATH,
    [
      region(h, {
        id: 'team-map-header',
        deps: [model.moving, model.notice],
        render: () =>
          h.header(
            [h.Id('team-map-header'), h.Class('flex h-11 shrink-0 items-center gap-3 border-b px-4')],
            [
              h.h1([h.Class('text-[13px] font-semibold')], ['Team map']),
              h.span([h.Id('team-map-notice'), h.Class('flex-1 text-[12px] text-muted-foreground'), h.AriaLive('polite')], [model.notice ?? '']),
              h.button(
                [
                  h.Id('team-map-move'),
                  h.Type('button'),
                  h.AriaPressed(model.moving ? 'true' : 'false'),
                  h.OnClick(Message.ClickedMove()),
                  h.Class(model.moving ? 'rounded-md bg-primary px-2.5 py-1 text-[12px] text-primary-foreground' : 'rounded-md border px-2.5 py-1 text-[12px] hover:bg-accent'),
                ],
                [model.moving ? 'Cancel' : 'Move my marker'],
              ),
            ],
          ),
      }),
      h.div(
        [h.Class('flex-1 overflow-y-auto p-4')],
        [
          h.div(
            [h.Class('grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]')],
            [
              region(h, { id: 'team-map-island', deps: [model.cities, model.selected, model.moving], render: () => h.div([h.Id('team-map-island')], [cityMap(model, h)]) }),
              region(h, { id: 'team-map-city', deps: [model.cities, model.selected], render: () => cityDetails(model, h) }),
            ],
          ),
        ],
      ),
    ],
    h,
  ),
})

export const program: Program<Model, Message, ClientMessage, Flags, Workspace | Contributions | ExtensionData> = {
  name: 'team-map',
  Model,
  ClientMessage,
  flags: request =>
    Effect.gen(function* () {
      const shell = yield* loadShell(request)
      const state = yield* Workspace.use(workspace => workspace.current)
      const rows = yield* ExtensionData.use(data => placesOf(data))
      return { shell, cities: citiesOf(rows, state.members, state.issues) }
    }),
  init,
  update,
  view,
  subscriptions,
  snapshotDeps: model => [model.selected, model.moving],
}
