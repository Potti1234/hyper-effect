import type { Html, HtmlBuilder } from 'foldkit/html'

import * as Island from '@hyper-effect/island'

import { type Place, PlaceMap } from './map-contract'

/* A map for any page of the app, extension pages included: places as
   markers with a tooltip (title and details) on hover or focus, panning and
   zooming, and the selected place ringed. It is an island (MapLibre with
   OpenFreeMap tiles, in the browser); the page sends the places, and a
   click on a place, or on the map with `onPick`, comes back as a Message.

     map({ id: 'offices', label: 'Our offices',
           places: [{ id: 'muc', longitude: 11.58, latitude: 48.14, title: 'Munich', details: ['4 people'] }],
           onClickPlace: id => Message.ClickedOffice({ id }) }, h) */

export type MapPlace = Readonly<{
  id: string
  longitude: number
  latitude: number
  title: string
  details?: ReadonlyArray<string>
  /** A few characters on the marker ("3", "ENG"); a dot without. */
  badge?: string
  tone?: Place['tone']
}>

export type MapConfig<Message> = Readonly<{
  /** Stable and unique on the page: the island lives as long as it does. */
  id: string
  /** What the map shows, for screen readers. */
  label: string
  places: ReadonlyArray<MapPlace>
  selectedId?: string | null
  /** Where to look first; without it, the map fits every place. */
  center?: readonly [number, number]
  zoom?: number
  /** In pixels. Default 360. */
  height?: number
  onClickPlace?: (id: string) => Message
  /** A click on the map, as a location. */
  onPick?: (location: Readonly<{ longitude: number; latitude: number }>) => Message
  class?: string
}>

export const map = <Message>(config: MapConfig<Message>, h: HtmlBuilder<Message>): Html => {
  const { onClickPlace, onPick } = config
  return Island.view(
    PlaceMap,
    {
      id: config.id,
      props: {
        places: config.places.map(place => ({
          id: place.id,
          longitude: place.longitude,
          latitude: place.latitude,
          badge: place.badge ?? '',
          title: place.title,
          details: place.details ?? [],
          tone: place.tone ?? 'info',
        })),
        selectedId: config.selectedId ?? null,
        center: config.center === undefined ? null : [config.center[0], config.center[1]],
        zoom: config.zoom ?? null,
        height: config.height ?? 360,
        label: config.label,
        clickable: onClickPlace !== undefined,
        pickable: onPick !== undefined,
      },
      ...(onClickPlace === undefined && onPick === undefined
        ? {}
        : {
            // An event the page did not ask for (a browser can post any) is dropped.
            onEvent: event =>
              event._tag === 'ClickedPlace'
                ? (onClickPlace?.(event.id) ?? null)
                : (onPick?.({ longitude: event.longitude, latitude: event.latitude }) ?? null),
          }),
      class: config.class ?? 'block w-full',
    },
    h,
  )
}
