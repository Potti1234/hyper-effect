import { Effect, Schema as S, Stream } from 'effect'

import type { ExtensionData } from '@hyper-effect/jellyware'

import { type Issue, type Member, isClosed } from '#app/domain'
import type { Workspace } from '#app/store'

/* Where members work, in the extension's own table `places`, and the
   cities the map shows: their people and their open issues. */

export const PlaceRow = S.Struct({ member_id: S.String, city: S.String, longitude: S.Number, latitude: S.Number })
export type PlaceRow = typeof PlaceRow.Type
const decodeRows = S.decodeUnknownEffect(S.Array(PlaceRow))

export const OpenIssue = S.Struct({ identifier: S.String, title: S.String })

export const Person = S.Struct({ id: S.String, name: S.String, open: S.Array(OpenIssue) })
export type Person = typeof Person.Type

export const City = S.Struct({
  /** The city's name: its id on the map. */
  name: S.String,
  longitude: S.Number,
  latitude: S.Number,
  people: S.Array(Person),
})
export type City = typeof City.Type

type Data = ExtensionData['Service']

export const placesOf = (data: Data) =>
  data.query('SELECT member_id, city, longitude, latitude FROM places ORDER BY city, member_id', []).pipe(Effect.flatMap(decodeRows), Effect.orDie)

/** The cities with their members, each with their open issues; a city's
 *  marker sits at the middle of its members' places. Members without a
 *  place are left out. */
export const citiesOf = (rows: ReadonlyArray<PlaceRow>, members: ReadonlyArray<Member>, issues: ReadonlyArray<Issue>): ReadonlyArray<City> => {
  const byCity = new Map<string, Array<PlaceRow>>()
  for (const row of rows) {
    if (!members.some(member => member.id === row.member_id)) continue
    byCity.set(row.city, [...(byCity.get(row.city) ?? []), row])
  }
  return [...byCity.entries()]
    .map(([name, places]) => ({
      name,
      longitude: places.reduce((sum, place) => sum + place.longitude, 0) / places.length,
      latitude: places.reduce((sum, place) => sum + place.latitude, 0) / places.length,
      people: places.map(place => {
        const member = members.find(candidate => candidate.id === place.member_id)
        return {
          id: place.member_id,
          name: member?.name ?? place.member_id,
          open: issues
            .filter(issue => issue.assigneeId === place.member_id && !isClosed(issue.status))
            .map(issue => ({ identifier: issue.identifier, title: issue.title })),
        }
      }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** How busy a city is: its people's open issues. */
export const openIn = (city: City): number => city.people.reduce((sum, person) => sum + person.open.length, 0)

/** The cities, now and after every move or workspace change. */
export const cityChanges = (data: Data, workspace: Workspace['Service']): Stream.Stream<ReadonlyArray<City>> =>
  Stream.zipLatest(data.changes, workspace.changes).pipe(
    Stream.mapEffect(([, state]) => Effect.map(placesOf(data), rows => citiesOf(rows, state.members, state.issues))),
    Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
  )

/** Moves a member's marker to a picked location; a member without a place
 *  gets one named "Elsewhere". */
export const moveTo = (data: Data, memberId: string, longitude: number, latitude: number) =>
  data
    .run(
      'INSERT INTO places (member_id, city, longitude, latitude) VALUES (?, ?, ?, ?) ON CONFLICT (member_id) DO UPDATE SET longitude = excluded.longitude, latitude = excluded.latitude',
      [memberId, 'Elsewhere', longitude, latitude],
    )
    .pipe(Effect.asVoid, Effect.mapError(error => error.message))
