import { Effect, Match as M, Schema as S } from 'effect'
import { Command, Port, Runtime, Subscription, type Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import { cn } from '@/lib/utils'
import { MapMessage, map as mapView } from '@/ui/map'
import { mapControls } from '@/ui/map-controls'
import { mapMarker } from '@/ui/map-marker'

import { MapEvent, MapProps, type Place, type PlaceTone, fitPlaces } from './map-contract'

/* The map island: crease/ui's MapLibre map in a Foldkit program in the
   browser. Panning, zooming and the tooltips stay here; a click on a place,
   or on the map when the page picks locations, goes out as an event. The
   view fits every place unless the page names a center, and fits again
   when the set of places changes; a new selection is panned into view. */

// MODEL

const Viewport = S.Struct({
  center: S.Tuple([S.Number, S.Number]),
  zoom: S.Number,
  bearing: S.Number,
  pitch: S.Number,
})
type Viewport = typeof Viewport.Type

export const Model = S.Struct({ props: MapProps, viewport: Viewport })
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ReceivedProps: { props: MapProps },
  GotMapMessage: { message: MapMessage },
  ClickedPlace: { id: S.String },
  CompletedEmit: {},
})
export type Message = typeof Message.Type

// PORT

export const ports = {
  inbound: { props: Port.inbound(MapProps) },
  outbound: { events: Port.outbound(MapEvent) },
}

// COMMAND

const Emit = Command.define('EmitMapEvent', {
  args: { event: MapEvent },
  messages: [Message.CompletedEmit],
  execute: ({ event }) => Port.emit(ports.outbound.events, event).pipe(Effect.as(Message.CompletedEmit())),
})

// INIT

/** The first view: the page's, or one that fits the places. */
const viewportOf = (props: MapProps): Viewport => {
  const fitted = fitPlaces(props.places, 720, props.height)
  return {
    center: props.center === null ? [fitted.center[0], fitted.center[1]] : [props.center[0], props.center[1]],
    zoom: props.zoom ?? (props.center === null ? fitted.zoom : 12),
    bearing: 0,
    pitch: 0,
  }
}

export const init = (props: MapProps): Update.Return<Model, Message> => ({ model: { props, viewport: viewportOf(props) } })

// UPDATE

type UpdateReturn = Update.Return<Model, Message>

const idsOf = (props: MapProps) => props.places.map(place => place.id).join(',')

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      // Other places: look at them all again. A new selection: bring it into view.
      ReceivedProps: ({ props }) => {
        const selected =
          props.selectedId !== model.props.selectedId ? props.places.find(place => place.id === props.selectedId) : undefined
        const viewport =
          idsOf(props) !== idsOf(model.props) || props.center?.join() !== model.props.center?.join()
            ? viewportOf(props)
            : selected === undefined
              ? model.viewport
              : { ...model.viewport, center: [selected.longitude, selected.latitude] as const }
        return { model: { props, viewport: { ...viewport, center: [viewport.center[0], viewport.center[1]] } } }
      },
      GotMapMessage: ({ message: mapMessage }) =>
        M.value(mapMessage).pipe(
          M.withReturnType<UpdateReturn>(),
          M.tag('MapViewportChanged', viewport => ({
            model: { ...model, viewport: { center: viewport.center, zoom: viewport.zoom, bearing: viewport.bearing, pitch: viewport.pitch } },
          })),
          M.tag('MapClicked', ({ longitude, latitude }) =>
            model.props.pickable
              ? { model, commands: [Emit({ event: MapEvent.members[1].make({ longitude, latitude }) })] }
              : { model },
          ),
          M.orElse(() => ({ model })),
        ),
      ClickedPlace: ({ id }) =>
        model.props.clickable ? { model, commands: [Emit({ event: MapEvent.members[0].make({ id }) })] } : { model },
      CompletedEmit: () => ({ model }),
    }),
  )

// SUBSCRIPTION

export const subscriptions = Subscription.make<Model, Message>()(_entry => ({
  props: Port.subscriptionEntry(ports.inbound.props, props => Message.ReceivedProps({ props })),
}))

// VIEW

const TONE: Readonly<Record<PlaceTone, string>> = {
  neutral: 'bg-zinc-600 text-white',
  info: 'bg-blue-600 text-white',
  success: 'bg-emerald-600 text-white',
  warning: 'bg-amber-500 text-white',
  danger: 'bg-red-600 text-white',
}

const placeView = (place: Place, selected: boolean, clickable: boolean, h: HtmlBuilder<Message>): Html =>
  mapMarker(
    {
      id: place.id,
      longitude: place.longitude,
      latitude: place.latitude,
      ariaLabel: [place.title, ...place.details].join('. '),
      ...(clickable ? { onClick: Message.ClickedPlace({ id: place.id }) } : {}),
      children: [
        h.span(
          [
            h.DataAttribute('place', place.id),
            h.Class(
              cn(
                'flex items-center justify-center rounded-full font-semibold shadow-md ring-2 ring-background transition-transform',
                place.badge === '' ? 'size-3.5' : 'h-6 min-w-6 px-1.5 text-[10.5px]',
                TONE[place.tone],
                selected && 'scale-125 ring-4 ring-primary',
              ),
            ),
            h.AriaHidden(true),
          ],
          [place.badge],
        ),
        // The tooltip: on hover and on keyboard focus.
        h.span(
          [
            h.Role('tooltip'),
            h.Class(
              'pointer-events-none absolute bottom-full z-30 mb-1.5 hidden min-w-32 max-w-64 rounded-md border bg-popover px-2.5 py-1.5 text-left text-[12px] whitespace-normal text-popover-foreground shadow-md group-hover:block group-focus-visible:block',
            ),
          ],
          [
            h.span([h.Class('block font-semibold')], [place.title]),
            ...place.details.map(detail => h.span([h.Class('block text-muted-foreground')], [detail])),
          ],
        ),
      ],
    },
    h,
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('w-full'), h.Style({ height: `${model.props.height}px` })],
    [
      mapView(
        {
          ariaLabel: model.props.label,
          viewport: model.viewport,
          cooperativeGestures: false,
          toMessage: message => Message.GotMapMessage({ message }),
          class: 'h-full min-h-0 rounded-lg border',
          children: [
            ...model.props.places.map(place => placeView(place, place.id === model.props.selectedId, model.props.clickable, h)),
            mapControls({ position: 'top-right', showCompass: false }, h),
          ],
        },
        h,
      ),
    ],
  )

// PROGRAM

export const makeMap = (container: HTMLElement, props: MapProps) =>
  Runtime.makeElement({
    Model,
    Flags: MapProps,
    flags: Effect.succeed(props),
    init,
    update,
    view,
    subscriptions,
    ports,
    container,
  })
