import { Schema as S } from 'effect'

import * as Island from '@hyper-effect/island/contract'

import { Location, Severity, Status } from '../domain'

/* Contract of the incident map island, shared by the server pages (which
   render it and receive its events) and the browser (which runs it). */

export const MapMarker = S.Struct({
  id: S.String,
  title: S.String,
  severity: Severity,
  status: Status,
  longitude: S.Number,
  latitude: S.Number,
})
export type MapMarker = typeof MapMarker.Type

/** Server → island. */
export const IncidentMapProps = S.Struct({
  markers: S.Array(MapMarker),
  selectedId: S.NullOr(S.String),
  /** Where the incident being reported will go. */
  draft: S.NullOr(Location),
  /** `pick`: clicking the map picks a location. `view`: read-only. */
  mode: S.Literals(['pick', 'view']),
})
export type IncidentMapProps = typeof IncidentMapProps.Type

/** Island → server. */
export const IncidentMapEvent = S.Union([
  S.TaggedStruct('SelectedMarker', { id: S.String }),
  S.TaggedStruct('PickedLocation', { longitude: S.Number, latitude: S.Number }),
])
export type IncidentMapEvent = typeof IncidentMapEvent.Type

export const IncidentMap = Island.define({
  tag: 'incident-map',
  Props: IncidentMapProps,
  Event: IncidentMapEvent,
})
