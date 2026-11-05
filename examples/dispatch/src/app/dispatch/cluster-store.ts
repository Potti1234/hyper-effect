import type { Worker } from 'node:cluster'

import { Effect, Layer, ManagedRuntime, Stream, SubscriptionRef } from 'effect'

import type { Incident } from './domain'
import {
  type DispatchState,
  IncidentNotFound,
  IncidentStore,
  Presence,
  layer as localLayer,
} from './store'

/* Dispatch on several cores. The primary process holds the one store and the
   presence list; every worker holds a mirror. Writes go to the primary over
   IPC, and every new state is broadcast to all workers, so a change made on
   one core reaches the pages on every core. This stands in for a database
   plus a change feed (Postgres LISTEN/NOTIFY, Redis pub/sub): the pages see
   the same `IncidentStore` and `Presence` services either way. */

type Call =
  | Readonly<{ op: 'create'; args: Parameters<IncidentStore['Service']['create']> }>
  | Readonly<{ op: 'setStatus'; args: Parameters<IncidentStore['Service']['setStatus']> }>
  | Readonly<{ op: 'comment'; args: Parameters<IncidentStore['Service']['comment']> }>

type ToPrimary =
  | Readonly<{ kind: 'hello' }>
  | (Readonly<{ kind: 'call'; id: number }> & Call)
  | Readonly<{ kind: 'join'; id: string; callsign: string }>
  | Readonly<{ kind: 'leave'; id: string }>

type ToWorker =
  | Readonly<{ kind: 'state'; state: DispatchState }>
  | Readonly<{ kind: 'online'; online: ReadonlyArray<string> }>
  | Readonly<{ kind: 'reply'; id: number; incident: Incident }>
  | Readonly<{ kind: 'failed'; id: number; notFound: string }>

const isToWorker = (message: unknown): message is ToWorker =>
  typeof message === 'object' && message !== null && 'kind' in message

// PRIMARY

/** Runs the shared store in the primary and serves the workers' calls. */
export const startHub = async (workers: () => ReadonlyArray<Worker>) => {
  const runtime = ManagedRuntime.make(localLayer)
  const store = await runtime.runPromise(Effect.gen(function* () { return yield* IncidentStore }))
  const joins = new Map<string, Readonly<{ worker: number; callsign: string }>>()
  let state = await runtime.runPromise(store.current)

  const send = (worker: Worker, message: ToWorker) => {
    if (worker.isConnected()) worker.send(message)
  }
  const broadcast = (message: ToWorker) => workers().forEach(worker => send(worker, message))
  const online = (): ToWorker => ({ kind: 'online', online: [...joins.values()].map(join => join.callsign) })

  runtime.runFork(
    store.changes.pipe(
      Stream.runForEach(next =>
        Effect.sync(() => {
          state = next
          broadcast({ kind: 'state', state })
        }),
      ),
    ),
  )

  const call = (message: Call) =>
    message.op === 'create'
      ? store.create(...message.args)
      : message.op === 'setStatus'
        ? store.setStatus(...message.args)
        : store.comment(...message.args)

  const attach = (worker: Worker) => {
    worker.on('message', (message: ToPrimary) => {
      switch (message.kind) {
        case 'hello':
          send(worker, { kind: 'state', state })
          send(worker, online())
          return
        case 'call':
          runtime.runPromise(
            call(message).pipe(
              Effect.match({
                onSuccess: incident => send(worker, { kind: 'reply', id: message.id, incident }),
                onFailure: error => send(worker, { kind: 'failed', id: message.id, notFound: error.id }),
              }),
            ),
          )
          return
        case 'join':
          joins.set(message.id, { worker: worker.id, callsign: message.callsign })
          broadcast(online())
          return
        case 'leave':
          joins.delete(message.id)
          broadcast(online())
          return
      }
    })
    // A worker that dies takes its pages, and so their presence, with it.
    worker.on('exit', () => {
      for (const [id, join] of joins) if (join.worker === worker.id) joins.delete(id)
      broadcast(online())
    })
  }

  return { attach, dispose: () => runtime.dispose() }
}

// WORKER

const send = (message: ToPrimary) => process.send?.(message)

/** The store and presence of a worker: a mirror of the primary's. */
export const workerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const states = yield* SubscriptionRef.make<DispatchState | undefined>(undefined)
    const onlineRef = yield* SubscriptionRef.make<ReadonlyArray<string>>([])
    const pending = new Map<number, (result: ToWorker) => void>()
    let nextCall = 0
    let nextJoin = 0

    process.on('message', (message: unknown) => {
      if (!isToWorker(message)) return
      switch (message.kind) {
        case 'state':
          Effect.runSync(SubscriptionRef.set(states, message.state))
          return
        case 'online':
          Effect.runSync(SubscriptionRef.set(onlineRef, message.online))
          return
        case 'reply':
        case 'failed':
          pending.get(message.id)?.(message)
          pending.delete(message.id)
          return
      }
    })
    send({ kind: 'hello' })

    // Wait for the primary's state before serving anything.
    const state = SubscriptionRef.changes(states).pipe(
      Stream.filter((value): value is DispatchState => value !== undefined),
    )
    yield* Stream.runHead(state)

    const remote = (call: Call) =>
      Effect.callback<Incident, IncidentNotFound>(resume => {
        nextCall += 1
        const id = nextCall
        pending.set(id, result =>
          resume(
            result.kind === 'reply'
              ? Effect.succeed(result.incident)
              : Effect.fail(new IncidentNotFound({ id: result.kind === 'failed' ? result.notFound : '' })),
          ),
        )
        send({ kind: 'call', id, ...call })
      })

    const current = SubscriptionRef.get(states).pipe(Effect.map(value => value as DispatchState))

    const incidents = Layer.succeed(IncidentStore, {
      current,
      changes: state,
      find: id =>
        current.pipe(
          Effect.flatMap(value => {
            const incident = value.incidents.find(candidate => candidate.id === id)
            return incident === undefined ? Effect.fail(new IncidentNotFound({ id })) : Effect.succeed(incident)
          }),
        ),
      create: (input, by) => remote({ op: 'create', args: [input, by] }) as Effect.Effect<Incident>,
      setStatus: (id, status, by) => remote({ op: 'setStatus', args: [id, status, by] }),
      comment: (id, text, by) => remote({ op: 'comment', args: [id, text, by] }),
    })

    const presence = Layer.succeed(Presence, {
      join: callsign =>
        Effect.acquireRelease(
          Effect.sync(() => {
            nextJoin += 1
            const id = `${process.pid}.${nextJoin}`
            send({ kind: 'join', id, callsign })
            return id
          }),
          id => Effect.sync(() => send({ kind: 'leave', id })),
        ).pipe(Effect.asVoid),
      online: SubscriptionRef.changes(onlineRef),
    })

    return Layer.mergeAll(incidents, presence)
  }),
)
