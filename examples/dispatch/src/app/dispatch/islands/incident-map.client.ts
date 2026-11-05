import { Effect, Match as M, Schema as S } from 'effect'
import { Command, Port, Runtime } from 'foldkit'
import type { Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { Subscription } from 'foldkit'

import { cn } from '@/lib/utils'
import { map, MapMessage } from '@/ui/map'
import { mapControls } from '@/ui/map-controls'
import { mapMarker, markerTooltip } from '@/ui/map-marker'

import type { Severity } from '../domain'
import { IncidentMapEvent, IncidentMapProps, type MapMarker } from './incident-map'

/* The incident map island: an ordinary Foldkit program, running in the
   browser, built on crease/ui's MapLibre map. Panning, zooming, hovering and
   the viewport readout never leave the browser. Only facts the server must
   know (a marker was selected, a location was picked) go out through the
   `events` Port; the server's answer comes back as new `props`. */

// MODEL

const Viewport = S.Struct({
  center: S.Tuple([S.Number, S.Number]),
  zoom: S.Number,
  bearing: S.Number,
  pitch: S.Number,
})
type Viewport = typeof Viewport.Type

export const Model = S.Struct({
  props: IncidentMapProps,
  viewport: Viewport,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ReceivedProps: { props: IncidentMapProps },
  GotMapMessage: { message: MapMessage },
  ClickedMarker: { id: S.String },
  CompletedEmitEvent: {},
})
export type Message = typeof Message.Type

// PORT

export const ports = {
  inbound: { props: Port.inbound(IncidentMapProps) },
  outbound: { events: Port.outbound(IncidentMapEvent) },
}

// COMMAND

const EmitEvent = Command.define('EmitEvent', {
  args: { event: IncidentMapEvent },
  messages: [Message.CompletedEmitEvent],
  execute: ({ event }) =>
    Port.emit(ports.outbound.events, event).pipe(Effect.as(Message.CompletedEmitEvent())),
})

// INIT

const MUNICH: Viewport = { center: [11.5755, 48.1395], zoom: 12.6, bearing: 0, pitch: 0 }

const focusOn = (marker: MapMarker, viewport: Viewport): Viewport => ({
  ...viewport,
  center: [marker.longitude, marker.latitude],
  zoom: Math.max(viewport.zoom, 14),
})

const selectedMarker = (props: IncidentMapProps): MapMarker | undefined =>
  props.markers.find(marker => marker.id === props.selectedId)

export const init = (props: IncidentMapProps): Update.Return<Model, Message> => {
  const selected = selectedMarker(props)
  return {
    model: { props, viewport: selected === undefined ? MUNICH : focusOn(selected, MUNICH) },
  }
}

// UPDATE

type UpdateReturn = Update.Return<Model, Message>

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ReceivedProps: ({ props }) => {
        // The server changed the selection: bring it into view.
        const selected =
          props.selectedId !== model.props.selectedId ? selectedMarker(props) : undefined
        return {
          model: {
            props,
            viewport: selected === undefined ? model.viewport : focusOn(selected, model.viewport),
          },
        }
      },
      GotMapMessage: ({ message: mapMessage }) =>
        M.value(mapMessage).pipe(
          M.withReturnType<UpdateReturn>(),
          M.tag('MapViewportChanged', viewport => ({
            model: {
              ...model,
              viewport: {
                center: viewport.center,
                zoom: viewport.zoom,
                bearing: viewport.bearing,
                pitch: viewport.pitch,
              },
            },
          })),
          M.tag('MapClicked', ({ longitude, latitude }) =>
            model.props.mode === 'pick'
              ? {
                  model,
                  commands: [
                    EmitEvent({
                      event: IncidentMapEvent.members[1].make({ longitude, latitude }),
                    }),
                  ],
                }
              : { model },
          ),
          M.orElse(() => ({ model })),
        ),
      ClickedMarker: ({ id }) => ({
        model,
        commands: [EmitEvent({ event: IncidentMapEvent.members[0].make({ id }) })],
      }),
      CompletedEmitEvent: () => ({ model }),
    }),
  )

// SUBSCRIPTION

export const subscriptions = Subscription.make<Model, Message>()(_entry => ({
  props: Port.subscription(ports.inbound.props, props => Message.ReceivedProps({ props })),
}))

// VIEW

const severityClass: Readonly<Record<Severity, string>> = {
  high: 'bg-red-600 text-white',
  medium: 'bg-amber-500 text-white',
  low: 'bg-sky-600 text-white',
}

const markerView = (marker: MapMarker, isSelected: boolean, h: HtmlBuilder<Message>): Html =>
  mapMarker(
    {
      id: marker.id,
      longitude: marker.longitude,
      latitude: marker.latitude,
      ariaLabel: `${marker.id}: ${marker.title}`,
      onClick: Message.ClickedMarker({ id: marker.id }),
      children: [
        h.span(
          [
            h.Class(
              cn(
                'flex size-6 items-center justify-center rounded-full text-[10px] font-semibold shadow-md ring-2 ring-background transition-transform',
                severityClass[marker.severity],
                marker.status === 'resolved' && 'opacity-40',
                isSelected && 'size-8 ring-4 ring-primary',
              ),
            ),
            h.AriaHidden(true),
          ],
          [marker.id.slice(-3)],
        ),
        markerTooltip({ children: [marker.title] }, h),
      ],
    },
    h,
  )

const draftView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  model.props.draft === null
    ? []
    : [
        mapMarker(
          {
            id: 'draft',
            longitude: model.props.draft.longitude,
            latitude: model.props.draft.latitude,
            ariaLabel: 'New incident location',
            children: [
              h.span(
                [
                  h.Class(
                    'flex size-7 animate-pulse items-center justify-center rounded-full border-2 border-dashed border-primary bg-background/80 text-sm font-bold text-primary shadow-md',
                  ),
                  h.AriaHidden(true),
                ],
                ['+'],
              ),
            ],
          },
          h,
        ),
      ]

const readout = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class(
        'pointer-events-none absolute bottom-2 left-2 z-20 rounded-md bg-background/90 px-2 py-1 font-mono text-[11px] text-muted-foreground shadow-sm',
      ),
    ],
    [
      `z ${model.viewport.zoom.toFixed(1)} · ${model.viewport.center[1].toFixed(4)}, ${model.viewport.center[0].toFixed(4)}`,
      model.props.mode === 'pick' ? ' · click to place' : '',
    ],
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  map(
    {
      ariaLabel: 'Incident map',
      viewport: model.viewport,
      cooperativeGestures: false,
      toMessage: message => Message.GotMapMessage({ message }),
      class: 'h-full min-h-0 rounded-xl border',
      children: [
        ...model.props.markers.map(marker =>
          markerView(marker, marker.id === model.props.selectedId, h),
        ),
        ...draftView(model, h),
        mapControls({ position: 'top-right', showCompass: false }, h),
        readout(model, h),
      ],
    },
    h,
  )

// PROGRAM

export const makeIncidentMap = (container: HTMLElement, props: IncidentMapProps) =>
  Runtime.makeElement({
    Model,
    Flags: IncidentMapProps,
    flags: Effect.succeed(props),
    init,
    update,
    view,
    subscriptions,
    ports,
    container,
  })
