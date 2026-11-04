import {
  Clock,
  Context,
  Data,
  Effect,
  Layer,
  type Scope,
  type Stream,
  SubscriptionRef,
} from 'effect'

import type { Activity, Incident, Location, Severity, Status } from './domain'

/* Shared, live state. Every page session subscribes to it, so a change made
   in one browser reaches every other open page within one render. In a real
   deployment this would be a database plus a change feed (LISTEN/NOTIFY, a
   message bus); the pages would not change. */

export type DispatchState = Readonly<{
  /** Unique per store instance and change (`<instance>.<n>`): equal versions
   *  mean equal content, so pages can share markup rendered for a version. */
  version: string
  incidents: ReadonlyArray<Incident>
  activity: ReadonlyArray<Activity>
}>

export class IncidentNotFound extends Data.TaggedError('IncidentNotFound')<{
  readonly id: string
}> {}

export type CreateIncident = Readonly<{
  title: string
  severity: Severity
  location: Location
}>

export class IncidentStore extends Context.Service<
  IncidentStore,
  {
    readonly current: Effect.Effect<DispatchState>
    readonly changes: Stream.Stream<DispatchState>
    readonly find: (id: string) => Effect.Effect<Incident, IncidentNotFound>
    readonly create: (input: CreateIncident, by: string) => Effect.Effect<Incident>
    readonly setStatus: (
      id: string,
      status: Status,
      by: string,
    ) => Effect.Effect<Incident, IncidentNotFound>
    readonly comment: (
      id: string,
      text: string,
      by: string,
    ) => Effect.Effect<Incident, IncidentNotFound>
  }
>()('dispatch/IncidentStore') {
  static readonly layer = Layer.effect(
    IncidentStore,
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const instance = yield* Effect.sync(() => crypto.randomUUID().slice(0, 8))
      let changes = 1
      const nextVersion = () => {
        changes += 1
        return `${instance}.${changes}`
      }
      const state = yield* SubscriptionRef.make<DispatchState>(seed(now, `${instance}.1`))
      let nextActivityId = 1000

      const log = (text: string, incidentId: string | null, at: number) => {
        nextActivityId += 1
        return { id: nextActivityId, at, text, incidentId }
      }

      const change = (
        id: string,
        f: (incident: Incident, at: number) => Readonly<{ incident: Incident; text: string }>,
      ) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          const current = yield* SubscriptionRef.get(state)
          const incident = current.incidents.find(candidate => candidate.id === id)
          if (incident === undefined) {
            return yield* new IncidentNotFound({ id })
          }
          const next = f(incident, at)
          yield* SubscriptionRef.set(state, {
            version: nextVersion(),
            incidents: current.incidents.map(candidate =>
              candidate.id === id ? next.incident : candidate,
            ),
            activity: [log(next.text, id, at), ...current.activity].slice(0, 30),
          })
          return next.incident
        })

      return {
        current: SubscriptionRef.get(state),
        changes: SubscriptionRef.changes(state),
        find: id =>
          SubscriptionRef.get(state).pipe(
            Effect.flatMap(current => {
              const incident = current.incidents.find(candidate => candidate.id === id)
              return incident === undefined
                ? Effect.fail(new IncidentNotFound({ id }))
                : Effect.succeed(incident)
            }),
          ),
        create: (input, by) =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis
            const current = yield* SubscriptionRef.get(state)
            const id = `INC-${101 + current.incidents.length}`
            const incident: Incident = {
              id,
              title: input.title,
              severity: input.severity,
              status: 'open',
              location: input.location,
              assignee: null,
              createdAt: at,
              comments: [],
            }
            yield* SubscriptionRef.set(state, {
              version: nextVersion(),
              incidents: [incident, ...current.incidents],
              activity: [
                log(`${by} reported ${id}: ${input.title}`, id, at),
                ...current.activity,
              ].slice(0, 30),
            })
            return incident
          }),
        setStatus: (id, status, by) =>
          change(id, incident => ({
            incident: {
              ...incident,
              status,
              assignee: status === 'assigned' ? by : status === 'open' ? null : incident.assignee,
            },
            text:
              status === 'assigned'
                ? `${by} took ${id}`
                : status === 'resolved'
                  ? `${by} resolved ${id}`
                  : `${by} reopened ${id}`,
          })),
        comment: (id, text, by) =>
          change(id, (incident, at) => ({
            incident: {
              ...incident,
              comments: [...incident.comments, { author: by, text, at }],
            },
            text: `${by} commented on ${id}`,
          })),
      }
    }),
  )
}

/** Who is looking at the board right now. Joining is a scoped resource: a
 *  dispatcher stays listed exactly as long as their page session lives. */
export class Presence extends Context.Service<
  Presence,
  {
    readonly join: (callsign: string) => Effect.Effect<void, never, Scope.Scope>
    readonly online: Stream.Stream<ReadonlyArray<string>>
  }
>()('dispatch/Presence') {
  static readonly layer = Layer.effect(
    Presence,
    Effect.gen(function* () {
      const online = yield* SubscriptionRef.make<ReadonlyArray<string>>([])
      return {
        join: callsign =>
          Effect.acquireRelease(
            SubscriptionRef.update(online, names => [...names, callsign]),
            () =>
              SubscriptionRef.update(online, names => {
                const index = names.indexOf(callsign)
                return index === -1 ? names : names.filter((_, at) => at !== index)
              }),
          ),
        online: SubscriptionRef.changes(online),
      }
    }),
  )
}

export const layer = Layer.mergeAll(IncidentStore.layer, Presence.layer)

const seed = (now: number, version: string): DispatchState => {
  const minutes = (count: number) => now - count * 60_000
  const incident = (
    id: string,
    title: string,
    severity: Severity,
    status: Status,
    longitude: number,
    latitude: number,
    age: number,
    assignee: string | null = null,
  ): Incident => ({
    id,
    title,
    severity,
    status,
    location: { longitude, latitude },
    assignee,
    createdAt: minutes(age),
    comments: [],
  })
  const incidents = [
    incident('INC-101', 'Traffic light outage at Stachus', 'high', 'open', 11.5655, 48.1391, 4),
    incident('INC-102', 'Water main leak, Leopoldstraße', 'high', 'assigned', 11.5822, 48.1593, 19, 'Heron 41'),
    incident('INC-103', 'Fallen tree blocking bike lane', 'medium', 'open', 11.5935, 48.1503, 27),
    incident('INC-104', 'Street lamp flickering near Gärtnerplatz', 'low', 'open', 11.5764, 48.1316, 45),
    incident('INC-105', 'Blocked drain, Sendlinger Tor', 'medium', 'assigned', 11.5671, 48.1339, 63, 'Otter 27'),
    incident('INC-106', 'Damaged bus shelter, Ostbahnhof', 'low', 'resolved', 11.6049, 48.1274, 120, 'Lynx 52'),
    incident('INC-107', 'Elevator out of service, Marienplatz', 'medium', 'open', 11.5755, 48.1372, 8),
  ]
  return {
    version,
    incidents,
    activity: incidents
      .slice()
      .reverse()
      .map((item, index) => ({
        id: index + 1,
        at: item.createdAt,
        text: `${item.id} reported: ${item.title}`,
        incidentId: item.id,
      }))
      .reverse(),
  }
}

/** How often pages pick up presence changes. Every change re-renders every
 *  open page, so with many pages this should be coarse (load tests raise it). */
export const PRESENCE_SAMPLE = `${Number(process.env['DISPATCH_PRESENCE_SAMPLE_SECONDS'] ?? 2)} seconds` as const
