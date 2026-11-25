import { Cause, Deferred, Effect, Exit, Fiber, Queue, Schema as S, Scope, Stream } from 'effect'

/* Both ends of the channel between the server and an extension's process
   (Node's IPC channel, `child.send` / `process.send`). Each end serves
   handlers by name and calls the other end's:

   - `call`: one answer (a value, a failure, or a defect);
   - `stream`: values until the end, a failure, or a cancel from the caller;
   - `scoped`: a registration that lasts until the caller's scope closes
     (a sidebar entry, a page): the callee keeps a scope open for it.

   A failure crosses as plain data: a tagged error stays a plain object with
   its `_tag` (so `Effect.catchTag` still works), a defect becomes a message.
   When the channel closes, or this end's scope does, every pending call and
   stream on this end dies. */

export type Port = Readonly<{
  send: (message: unknown) => void
  onMessage: (handler: (message: unknown) => void) => void
  /** Called once when the other end is gone. */
  onClose: (handler: (reason: string) => void) => void
}>

export type Handler =
  | Readonly<{ kind: 'call'; run: (args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown> }>
  | Readonly<{ kind: 'stream'; open: (args: ReadonlyArray<unknown>) => Stream.Stream<unknown, unknown> }>
  | Readonly<{ kind: 'scoped'; acquire: (args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown, Scope.Scope> }>

export type Peer = Readonly<{
  call: (name: string, args?: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>
  stream: (name: string, args?: ReadonlyArray<unknown>) => Stream.Stream<unknown, unknown>
  scoped: (name: string, args?: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown, Scope.Scope>
  /** Why the channel closed, once it did. */
  closed: Effect.Effect<string>
}>

type Outcome = Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; error: unknown }> | Readonly<{ ok: false; defect: string }>

type Message =
  | Readonly<{ t: 'call' | 'open' | 'acquire'; id: number; name: string; args: ReadonlyArray<unknown> }>
  | Readonly<{ t: 'cancel' | 'release'; id: number }>
  | Readonly<{ t: 'done'; id: number; outcome: Outcome }>
  | Readonly<{ t: 'item'; id: number; value: unknown }>
  | Readonly<{ t: 'end'; id: number; outcome: Outcome }>

const isMessage = (value: unknown): value is Message =>
  typeof value === 'object' && value !== null && 't' in value && 'id' in value && typeof value.id === 'number'

/** A failure as plain data: an object's own fields with `_tag` and
 *  `message`, anything else as text. */
export const encodeError = (error: unknown): unknown => {
  if (typeof error !== 'object' || error === null) return error
  const plain: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(error)) {
    if (typeof value !== 'function') plain[key] = value
  }
  if ('_tag' in error) plain['_tag'] = error._tag
  if (error instanceof Error) plain['message'] = error.message
  return plain
}

const outcomeOf = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<Outcome> =>
  effect.pipe(
    Effect.map((value): Outcome => ({ ok: true, value })),
    Effect.catch(error => Effect.succeed<Outcome>({ ok: false, error: encodeError(error) })),
    Effect.catchCause(cause => Effect.succeed<Outcome>({ ok: false, defect: Cause.pretty(cause) })),
  )

const fromOutcome = (outcome: Outcome): Effect.Effect<unknown, unknown> =>
  outcome.ok ? Effect.succeed(outcome.value) : 'error' in outcome ? Effect.fail(outcome.error) : Effect.die(new Error(outcome.defect))

/** Decodes what came across the channel with `schema`; what does not fit is
 *  a defect (the other end broke the contract). */
export const decodeOrDie =
  <A>(schema: S.Decoder<A>) =>
  (value: unknown): Effect.Effect<A> =>
    S.decodeUnknownEffect(schema)(value).pipe(Effect.orDie)

/** Starts one end of the channel for the current scope. `handlers` may be
 *  filled after the peer is made, before the other end calls them. */
export const make = (port: Port, handlers: Map<string, Handler>): Effect.Effect<Peer, never, Scope.Scope> =>
  Effect.gen(function* () {
    // Handlers, the message loop and held registrations run in a scope of
    // their own, closed last: while the caller's scope closes, the other end
    // can still call back (a page writing its last snapshots).
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
    const inbox = yield* Queue.unbounded<Message | Readonly<{ t: 'closed'; reason: string }>>()
    const closed = yield* Deferred.make<string>()
    let isClosed = false
    let nextId = 1

    const send = (message: Message) => {
      if (isClosed) return
      try {
        port.send(message)
      } catch {
        // The other end is gone; the close event follows.
      }
    }

    // The caller's side.
    const pending = new Map<number, Deferred.Deferred<Outcome>>()
    const streams = new Map<number, Queue.Queue<unknown, unknown | Cause.Done>>()
    // The callee's side.
    const serving = new Map<number, Fiber.Fiber<unknown, unknown>>()
    const holding = new Map<number, Scope.Closeable>()

    port.onMessage(message => {
      if (isMessage(message)) Queue.offerUnsafe(inbox, message)
    })
    port.onClose(reason => {
      Queue.offerUnsafe(inbox, { t: 'closed', reason })
    })

    const unknownName = (name: string): Outcome => ({ ok: false, defect: `No handler "${name}" on this end of the channel.` })

    const handle = (message: Message | Readonly<{ t: 'closed'; reason: string }>): Effect.Effect<void> =>
      Effect.gen(function* () {
        switch (message.t) {
          case 'closed': {
            isClosed = true
            yield* Deferred.succeed(closed, message.reason)
            const gone: Outcome = { ok: false, defect: `The other end of the channel is gone: ${message.reason}` }
            for (const deferred of pending.values()) yield* Deferred.succeed(deferred, gone)
            pending.clear()
            for (const queue of streams.values()) yield* Queue.failCause(queue, Cause.die(new Error(gone.defect)))
            streams.clear()
            for (const fiber of serving.values()) yield* Fiber.interrupt(fiber)
            serving.clear()
            for (const held of holding.values()) yield* Scope.close(held, Exit.void)
            holding.clear()
            return
          }
          case 'call': {
            const handler = handlers.get(message.name)
            const run = handler?.kind === 'call' ? outcomeOf(handler.run(message.args)) : Effect.succeed(unknownName(message.name))
            yield* run.pipe(
              Effect.flatMap(outcome => Effect.sync(() => send({ t: 'done', id: message.id, outcome }))),
              Effect.forkIn(scope),
            )
            return
          }
          case 'open': {
            const handler = handlers.get(message.name)
            if (handler?.kind !== 'stream') {
              send({ t: 'end', id: message.id, outcome: unknownName(message.name) })
              return
            }
            const fiber = yield* outcomeOf(
              Stream.runForEach(Stream.suspend(() => handler.open(message.args)), value =>
                Effect.sync(() => send({ t: 'item', id: message.id, value })),
              ),
            ).pipe(
              Effect.flatMap(outcome => Effect.sync(() => send({ t: 'end', id: message.id, outcome }))),
              Effect.ensuring(Effect.sync(() => serving.delete(message.id))),
              Effect.forkIn(scope),
            )
            serving.set(message.id, fiber)
            return
          }
          case 'acquire': {
            const handler = handlers.get(message.name)
            if (handler?.kind !== 'scoped') {
              send({ t: 'done', id: message.id, outcome: unknownName(message.name) })
              return
            }
            const held = yield* Scope.fork(scope)
            holding.set(message.id, held)
            yield* outcomeOf(Effect.suspend(() => handler.acquire(message.args)).pipe(Scope.provide(held))).pipe(
              Effect.flatMap(outcome =>
                Effect.gen(function* () {
                  if (!outcome.ok) {
                    holding.delete(message.id)
                    yield* Scope.close(held, Exit.void)
                  }
                  send({ t: 'done', id: message.id, outcome })
                }),
              ),
              Effect.forkIn(scope),
            )
            return
          }
          case 'cancel': {
            const fiber = serving.get(message.id)
            serving.delete(message.id)
            if (fiber !== undefined) yield* Fiber.interrupt(fiber).pipe(Effect.forkIn(scope))
            return
          }
          case 'release': {
            const held = holding.get(message.id)
            holding.delete(message.id)
            if (held !== undefined) yield* Scope.close(held, Exit.void).pipe(Effect.forkIn(scope))
            return
          }
          case 'done': {
            const deferred = pending.get(message.id)
            pending.delete(message.id)
            if (deferred !== undefined) yield* Deferred.succeed(deferred, message.outcome)
            return
          }
          case 'item': {
            const queue = streams.get(message.id)
            if (queue !== undefined) yield* Queue.offer(queue, message.value)
            return
          }
          case 'end': {
            const queue = streams.get(message.id)
            streams.delete(message.id)
            if (queue === undefined) return
            if (message.outcome.ok) yield* Queue.end(queue)
            else if ('error' in message.outcome) yield* Queue.fail(queue, message.outcome.error)
            else yield* Queue.failCause(queue, Cause.die(new Error(message.outcome.defect)))
          }
        }
      })

    yield* Queue.take(inbox).pipe(Effect.flatMap(handle), Effect.forever, Effect.forkIn(scope))
    // Closing this end ends what waits on the other one: a stream the server
    // forwards to a browser breaks, and the browser reconnects elsewhere.
    yield* Effect.addFinalizer(() => (isClosed ? Effect.void : handle({ t: 'closed', reason: 'this end was closed' })))

    const request = (t: 'call' | 'acquire', name: string, args: ReadonlyArray<unknown>) =>
      Effect.gen(function* () {
        const id = nextId++
        const deferred = yield* Deferred.make<Outcome>()
        const gone: Outcome = { ok: false, defect: 'The channel is closed.' }
        if (isClosed) return { id, outcome: gone }
        pending.set(id, deferred)
        send({ t, id, name, args })
        return { id, outcome: yield* Deferred.await(deferred) }
      })

    return {
      call: (name, args = []) => Effect.flatMap(request('call', name, args), ({ outcome }) => fromOutcome(outcome)),
      stream: (name, args = []) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const id = nextId++
            const queue = yield* Queue.unbounded<unknown, unknown | Cause.Done>()
            if (isClosed) yield* Queue.failCause(queue, Cause.die(new Error('The channel is closed.')))
            else {
              streams.set(id, queue)
              send({ t: 'open', id, name, args })
            }
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                if (streams.delete(id)) send({ t: 'cancel', id })
              }),
            )
            return Stream.fromQueue(queue)
          }),
        ),
      scoped: (name, args = []) =>
        Effect.acquireRelease(request('acquire', name, args), ({ id, outcome }) =>
          Effect.sync(() => {
            if (outcome.ok) send({ t: 'release', id })
          }),
        ).pipe(Effect.flatMap(({ outcome }) => fromOutcome(outcome))),
      closed: Deferred.await(closed),
    }
  })
