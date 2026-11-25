import { Schema as S } from 'effect'

import * as Island from '@hyper-effect/island/contract'

/* The map island's contract, shared by the server (`map` in map.ts) and the
   browser (map.client.ts). */

export const PlaceTone = S.Literals(['neutral', 'info', 'success', 'warning', 'danger'])
export type PlaceTone = typeof PlaceTone.Type

export const Place = S.Struct({
  id: S.String,
  longitude: S.Number,
  latitude: S.Number,
  /** A few characters on the marker itself ("3", "ENG"); empty for a dot. */
  badge: S.String,
  /** The tooltip's first line. */
  title: S.String,
  /** More tooltip lines. */
  details: S.Array(S.String),
  tone: PlaceTone,
})
export type Place = typeof Place.Type

/** Server → island. */
export const MapProps = S.Struct({
  places: S.Array(Place),
  selectedId: S.NullOr(S.String),
  /** Where the map looks first; null fits every place in view. */
  center: S.NullOr(S.Tuple([S.Number, S.Number])),
  zoom: S.NullOr(S.Number),
  height: S.Number,
  label: S.String,
  /** Whether a click on a place is reported. */
  clickable: S.Boolean,
  /** Whether a click on the map is reported as a picked location. */
  pickable: S.Boolean,
})
export type MapProps = typeof MapProps.Type

/** Island → server. */
export const MapEvent = S.Union([
  S.TaggedStruct('ClickedPlace', { id: S.String }),
  S.TaggedStruct('PickedLocation', { longitude: S.Number, latitude: S.Number }),
])
export type MapEvent = typeof MapEvent.Type

export const PlaceMap = Island.define({ tag: 'app-map', Props: MapProps, Event: MapEvent })

/** A view of the world that shows every place, for a map about
 *  `width` × `height` pixels (Web Mercator, 512px tiles). */
export const fitPlaces = (
  places: ReadonlyArray<Readonly<{ longitude: number; latitude: number }>>,
  width: number,
  height: number,
): Readonly<{ center: readonly [number, number]; zoom: number }> => {
  if (places.length === 0) return { center: [10, 50], zoom: 3 }
  const x = (longitude: number) => (longitude + 180) / 360
  const y = (latitude: number) => {
    const sin = Math.sin((Math.max(-85, Math.min(85, latitude)) * Math.PI) / 180)
    return 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)
  }
  const xs = places.map(place => x(place.longitude))
  const ys = places.map(place => y(place.latitude))
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const unproject = (value: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * value))) * 180) / Math.PI
  const center = [((x0 + x1) / 2) * 360 - 180, unproject((y0 + y1) / 2)] as const
  if (places.length === 1) return { center, zoom: 13 }
  // Room around the outermost places for their markers.
  const zoom = Math.log2(Math.min((width * 0.65) / 512 / Math.max(x1 - x0, 1e-6), (height * 0.65) / 512 / Math.max(y1 - y0, 1e-6)))
  return { center, zoom: Math.max(1, Math.min(15, zoom)) }
}
