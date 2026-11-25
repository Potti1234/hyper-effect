import { Cause, Context, Deferred, Effect, Exit, Layer, Redacted, Schema as S, Scope, Stream } from 'effect'
import { HttpRouter, HttpServer } from 'effect/http'
import { KeyValueStore } from 'effect/persistence'

import { PageHost, StylesheetChanges, servedPage } from '@hyper-effect/core'

import { type BadgeEntry, type CommandEntry, Contributions, Inventory, NavEntry, SlotBadge, SlotCard, type SlotEntry } from '../contributions.ts'
import { DataError, ExtensionData, SqlValueSchema } from '../data.ts'
import { ExtensionIslands } from '../islands/view.ts'
import { ExtensionSettings, type SettingValues, valuesOf } from '../settings.ts'
import { type Handler, type Peer, decodeOrDie, make } from './bridge.ts'
import type { RemoteService } from './remote.ts'

/* The extension's side of its own process (bundled with the extension by
   `isolatedExtension` in parent.ts, and started with Node's permission
   model: it reads only its bundle, and has no network, no child processes
   and none of the server's environment).

   It builds the extension against stand-ins that forward to the server: the
   app's services (as the app described them), the registry, the key-value
   store (limited to this extension's keys), the stylesheet changes and the
   member settings. It serves back what the server asks of it: a slot's
   content for a page, a command, a page's HTTP requests, a drain before
   another version takes over, and a heartbeat for the watchdog.

   Pages run here: the extension mounts them on a page host of this process,
   which serves them through a web handler; the server forwards their
   requests (`http.start`, `http.body`) and tells the page who is signed in
   with the header `x-jellyware-principal`. */

/** What the server sends to start the extension. */
const Start = S.Struct({
  id: S.String,
  values: S.Record(S.String, S.Union([S.String, S.Number, S.Boolean])),
  secrets: S.Record(S.String, S.String),
  /** Its islands' frame addresses, by name. */
  islands: S.Record(S.String, S.String),
})

const HttpRequest = S.Struct({
  mountId: S.Number,
  method: S.String,
  url: S.String,
  headers: S.Array(S.Tuple([S.String, S.String])),
  body: S.NullOr(S.Uint8Array),
})

const SlotContext = S.Record(S.String, S.String)
const CommandInput = S.Struct({ args: S.Json, memberId: S.String })
const Values = S.Record(S.String, S.Union([S.String, S.Number, S.Boolean]))
const HostedPage = S.Struct({ name: S.String, paths: S.Array(S.String), owner: S.NullOr(S.String) })
const Rows = S.Array(S.Record(S.String, SqlValueSchema))
const dataError = (error: unknown) =>
  new DataError({ message: typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error) })

const isClosedLayer = (value: unknown): value is Layer.Layer<unknown, unknown, never> => Layer.isLayer(value)

const decodeStart = (value: unknown) => S.decodeUnknownEffect(Start)(value).pipe(Effect.orDie)
const decodeRequest = (value: unknown) => S.decodeUnknownEffect(HttpRequest)(value).pipe(Effect.orDie)

/** A stand-in for one of the app's services: every listed member forwards. */
const standIn = (peer: Peer, service: RemoteService): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(service.members).map(([member, kind]) => {
      const name = `${service.key.key}.${member}`
      switch (kind) {
        case 'value':
          return [member, peer.call(name)]
        case 'stream':
          return [member, peer.stream(name)]
        case 'call':
          return [member, (...args: ReadonlyArray<unknown>) => peer.call(name, args)]
        case 'callStream':
          return [member, (...args: ReadonlyArray<unknown>) => peer.stream(name, args)]
        case 'scoped':
          return [member, (...args: ReadonlyArray<unknown>) => peer.scoped(name, args)]
      }
    }),
  )

export const runChild = (extension: unknown, services: ReadonlyArray<RemoteService>): void => {
  const handlers = new Map<string, Handler>()
  const serve = (name: string, handler: Handler) => handlers.set(name, handler)

  const program = Effect.gen(function* () {
    const peer = yield* make(
      {
        send: message => process.send?.(message),
        onMessage: handler => process.on('message', handler),
        onClose: handler => process.on('disconnect', () => handler('the server is gone')),
      },
      handlers,
    )
    const done = yield* Deferred.make<void>()

    // THE REGISTRY: entries live in the server; content and commands here.
    const slots = new Map<string, SlotEntry>()
    const badges = new Map<string, BadgeEntry>()
    const commands = new Map<string, CommandEntry>()
    const contributions = Contributions.of({
      nav: entry => Effect.asVoid(Effect.orDie(peer.scoped('contributions.nav', [entry]))),
      navChanges: peer.stream('contributions.navChanges').pipe(Stream.orDie, Stream.mapEffect(decodeOrDie(S.Array(NavEntry)))),
      navEntries: Effect.orDie(peer.call('contributions.navEntries')).pipe(Effect.flatMap(decodeOrDie(S.Array(NavEntry)))),
      slot: <R,>(entry: SlotEntry<R>) =>
        Effect.gen(function* () {
          const context = yield* Effect.context<R>()
          const key = `${entry.slot}\u0000${entry.id}`
          yield* Effect.acquireRelease(
            Effect.sync(() => slots.set(key, { ...entry, content: ctx => entry.content(ctx).pipe(Stream.provideContext(context)) })),
            () => Effect.sync(() => slots.delete(key)),
          )
          yield* Effect.orDie(peer.scoped('contributions.slot', [{ slot: entry.slot, id: entry.id, key }]))
        }),
      slotCards: (slot, context) =>
        peer.stream('contributions.slotCards', [slot, context]).pipe(Stream.orDie, Stream.mapEffect(decodeOrDie(S.Array(SlotCard)))),
      badges: <R,>(entry: BadgeEntry<R>) =>
        Effect.gen(function* () {
          const context = yield* Effect.context<R>()
          const key = `${entry.slot}\u0000${entry.id}`
          yield* Effect.acquireRelease(
            Effect.sync(() => badges.set(key, { ...entry, content: ctx => entry.content(ctx).pipe(Stream.provideContext(context)) })),
            () => Effect.sync(() => badges.delete(key)),
          )
          yield* Effect.orDie(peer.scoped('contributions.badges', [{ slot: entry.slot, id: entry.id, key }]))
        }),
      slotBadges: (slot, context) =>
        peer.stream('contributions.slotBadges', [slot, context]).pipe(Stream.orDie, Stream.mapEffect(decodeOrDie(S.Array(SlotBadge)))),
      command: <R,>(entry: CommandEntry<R>) =>
        Effect.gen(function* () {
          const context = yield* Effect.context<R>()
          yield* Effect.acquireRelease(
            Effect.sync(() => commands.set(entry.id, { ...entry, run: input => entry.run(input).pipe(Effect.provideContext(context)) })),
            () => Effect.sync(() => commands.delete(entry.id)),
          )
          yield* Effect.orDie(peer.scoped('contributions.command', [{ id: entry.id, roles: entry.roles ?? null }]))
        }),
      run: (id, input) => peer.call('contributions.run', [id, input]).pipe(Effect.mapError(String), Effect.map(String)),
      inventory: Effect.orDie(peer.call('contributions.inventory')).pipe(Effect.flatMap(decodeOrDie(Inventory))),
      inventoryChanges: peer.stream('contributions.inventoryChanges').pipe(Stream.orDie, Stream.mapEffect(decodeOrDie(Inventory))),
    })
    serve('slot.open', {
      kind: 'stream',
      open: ([key, context]) =>
        Stream.unwrap(Effect.map(decodeOrDie(SlotContext)(context), decoded => slots.get(String(key))?.content(decoded) ?? Stream.empty)),
    })
    serve('badges.open', {
      kind: 'stream',
      open: ([key, context]) =>
        Stream.unwrap(Effect.map(decodeOrDie(SlotContext)(context), decoded => badges.get(String(key))?.content(decoded) ?? Stream.empty)),
    })
    serve('command.run', {
      kind: 'call',
      run: ([id, input]) =>
        Effect.flatMap(decodeOrDie(CommandInput)(input), decoded => {
          const command = commands.get(String(id))
          return command === undefined ? Effect.fail('This action is no longer available.') : command.run(decoded)
        }),
    })

    // PAGES: served by this process, through the server's routes.
    type Served = Readonly<{ handler: (request: Request) => Promise<Response>; drain: Effect.Effect<void> }>
    const mounts = new Map<number, Served>()
    const bodies = new Map<number, ReadableStream<Uint8Array>>()
    let nextMount = 1
    let nextBody = 1
    const pageHost = PageHost.of({
      mount: (page, options = {}) =>
        Effect.gen(function* () {
          const { routes, drain } = yield* servedPage(page, options)
          const web = HttpRouter.toWebHandler(
            Layer.effectDiscard(Effect.flatMap(HttpRouter.HttpRouter, router => router.addAll(routes))).pipe(Layer.provide(HttpServer.layerServices)),
            { disableLogger: true },
          )
          yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()))
          const mountId = nextMount++
          yield* Effect.acquireRelease(
            Effect.sync(() => mounts.set(mountId, { handler: request => web.handler(request), drain })),
            () => Effect.sync(() => mounts.delete(mountId)),
          )
          const paths = [options.path ?? '/', ...(options.paths ?? [])]
          // A refused route (a path another page serves) fails the mount here.
          yield* peer.scoped('pages.mount', [{ mountId, name: page.name, paths }]).pipe(Effect.orDie)
        }),
      mountRoutes: () => Effect.die(new Error('An extension in its own process mounts programs, not routes.')),
      names: Effect.orDie(peer.call('pages.names')).pipe(Effect.flatMap(decodeOrDie(S.Array(S.String)))),
      pages: Effect.orDie(peer.call('pages.pages')).pipe(Effect.flatMap(decodeOrDie(S.Array(HostedPage)))),
    })
    serve('http.start', {
      kind: 'call',
      run: ([input]) =>
        Effect.gen(function* () {
          const request = yield* decodeRequest(input)
          const mount = mounts.get(request.mountId)
          if (mount === undefined) return { status: 503, headers: [], bodyId: null }
          const response = yield* Effect.promise(() =>
            mount.handler(
              new Request(`http://localhost${request.url}`, {
                method: request.method,
                headers: request.headers.map(([name, value]): [string, string] => [name, value]),
                ...(request.body === null ? {} : { body: new Uint8Array(request.body) }),
              }),
            ),
          )
          let bodyId: number | null = null
          if (response.body !== null) {
            bodyId = nextBody++
            const id = bodyId
            bodies.set(id, response.body)
            // A body nobody asks for is let go.
            setTimeout(() => {
              const left = bodies.get(id)
              bodies.delete(id)
              void left?.cancel().catch(() => undefined)
            }, 60_000).unref()
          }
          return { status: response.status, headers: [...response.headers], bodyId }
        }),
    })
    serve('http.body', {
      kind: 'stream',
      open: ([id]) => {
        const body = bodies.get(Number(id))
        bodies.delete(Number(id))
        return body === undefined ? Stream.empty : Stream.fromReadableStream({ evaluate: () => body, onError: error => error })
      },
    })
    serve('pages.drain', { kind: 'call', run: ([id]) => mounts.get(Number(id))?.drain ?? Effect.void })
    serve('ping', { kind: 'call', run: () => Effect.succeed('pong') })

    // STARTING AND STOPPING
    let running: Scope.Closeable | null = null
    serve('start', {
      kind: 'call',
      run: ([input]) =>
        Effect.gen(function* () {
          const start = yield* decodeStart(input)
          if (!isClosedLayer(extension)) return yield* Effect.fail('The entry module has no Layer as its default export.')
          let context = Context.empty().pipe(
            Context.add(Contributions, contributions),
            Context.add(PageHost, pageHost),
            Context.add(
              KeyValueStore.KeyValueStore,
              KeyValueStore.make({
                get: key => Effect.orDie(peer.call('kv.get', [key])).pipe(Effect.map(value => (typeof value === 'string' ? value : undefined))),
                getUint8Array: key =>
                  Effect.orDie(peer.call('kv.getUint8Array', [key])).pipe(Effect.map(value => (value instanceof Uint8Array ? value : undefined))),
                set: (key, value) => Effect.asVoid(Effect.orDie(peer.call('kv.set', [key, value]))),
                remove: key => Effect.asVoid(Effect.orDie(peer.call('kv.remove', [key]))),
                clear: Effect.asVoid(Effect.orDie(peer.call('kv.clear'))),
                size: Effect.orDie(peer.call('kv.size')).pipe(Effect.map(Number)),
                keys: Effect.orDie(peer.call('kv.keys')).pipe(
                  Effect.map(keys => (Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : [])),
                ),
              }),
            ),
            Context.add(
              ExtensionData,
              ExtensionData.of({
                query: (sql, params = []) =>
                  peer.call('data.query', [sql, params]).pipe(Effect.mapError(dataError), Effect.flatMap(decodeOrDie(Rows))),
                run: (sql, params = []) => peer.call('data.run', [sql, params]).pipe(Effect.mapError(dataError), Effect.map(Number)),
                changes: peer.stream('data.changes').pipe(Stream.orDie, Stream.map(Number)),
              }),
            ),
            Context.add(
              ExtensionIslands,
              ExtensionIslands.of({
                src: name => {
                  const src = start.islands[name]
                  return src === undefined
                    ? Effect.die(new Error(`There is no island "${name}": extension.json declares ${Object.keys(start.islands).join(', ') || 'none'}.`))
                    : Effect.succeed(src)
                },
              }),
            ),
            Context.add(StylesheetChanges, peer.stream('styles').pipe(Stream.orDie, Stream.mapEffect(decodeOrDie(S.Array(S.String))))),
            Context.add(
              ExtensionSettings,
              ExtensionSettings.of({
                ...valuesOf(start.values),
                secret: key => Redacted.make(start.secrets[key] ?? ''),
                hasSecret: key => (start.secrets[key] ?? '') !== '',
                forMember: (memberId): Stream.Stream<SettingValues> =>
                  peer.stream('settings.forMember', [memberId]).pipe(
                    Stream.orDie,
                    Stream.mapEffect(decodeOrDie(Values)),
                    Stream.map(valuesOf),
                  ),
              }),
            ),
          )
          for (const service of services) context = Context.add(context, service.key, standIn(peer, service))
          const scope = yield* Scope.make()
          const built = yield* Effect.exit(Layer.buildWithScope(Layer.provide(extension, Layer.succeedContext(context)), scope))
          if (Exit.isFailure(built)) {
            yield* Scope.close(scope, Exit.void)
            return yield* Effect.fail(Cause.pretty(built.cause))
          }
          running = scope
          return 'started'
        }),
    })
    serve('stop', {
      kind: 'call',
      run: () =>
        Effect.gen(function* () {
          if (running !== null) yield* Scope.close(running, Exit.void)
          running = null
          // After this answer has left.
          yield* Effect.sleep('50 millis').pipe(Effect.andThen(Deferred.succeed(done, undefined)), Effect.forkDetach)
          return 'stopped'
        }),
    })

    // Until told to stop, or the server goes.
    yield* Effect.raceFirst(Deferred.await(done), Effect.asVoid(peer.closed))
    if (running !== null) yield* Scope.close(running, Exit.void)
  }).pipe(Effect.scoped)

  Effect.runFork(program).addObserver(() => {
    // Let the last answer leave before the process ends.
    setTimeout(() => process.exit(0), 50)
  })
}
