import { Cause, Context, Data, Effect, Layer, type Scope, Semaphore } from 'effect'
import { HttpRouter, HttpServerError, HttpServerRequest, type HttpServerResponse } from 'effect/http'
import type { KeyValueStore } from 'effect/persistence'

import type { Program } from './program.ts'
import { serveDatastar, servedPage, type Options, type PageRoute } from './server.ts'

/* Pages added and removed while the server runs.

   An app's router cannot remove a route, and adding the same route twice
   throws, so a page that comes and goes (an extension, a module switched on
   for a tenant) cannot use `Hyper.layer`. The page host keeps the pages
   mounted now in a router of its own, rebuilt on every change, and the app's
   router hands it every request that none of its own routes matched.

   A page is mounted for the life of a scope. Mounting a page whose name is
   already mounted shadows the earlier one: requests go to the newest, and
   closing it reveals the previous one again. This is how a new version of a
   page replaces the old one without a gap: mount the new one, then close the
   old one.

   Sessions are handed over, not shared: when another version takes over a
   page's requests (a newer one is mounted, or the newer one closes and the
   older is revealed), requests wait for a moment, those already running
   finish, the version that stops serving closes its live sessions with
   their final snapshots, and only then do requests reach the other version,
   which restores each session from its snapshot when its browser
   reconnects. So no event lands in two versions, and no old snapshot
   overwrites a newer one. */

/** Mounting failed because a route of the page collides with a route of
 *  another mounted page (the same path pattern under a different name). */
export class PageConflict extends Data.TaggedError('PageConflict')<{
  /** The name of the page that was refused. */
  readonly page: string
  readonly message: string
}> {}

/** Who mounts pages from here on, for `PageHost.pages`: an extension's
 *  loader provides its id. Null (the default) for pages without one. */
export const PageOwner = Context.Reference<string | null>('@hyper-effect/core/PageOwner', { defaultValue: () => null })

/** A page served by the host. */
export type HostedPage = Readonly<{
  name: string
  /** The paths it answers GET requests on, as patterns (`/issue/:id`). */
  paths: ReadonlyArray<string>
  owner: string | null
}>

type Mounted = Readonly<{
  id: number
  name: string
  owner: string | null
  routes: ReadonlyArray<PageRoute>
  drain: Effect.Effect<void>
}>

/** Permits of the hand-over gate: every request holds one, a hand-over all. */
const GATE = 1_000_000

export class PageHost extends Context.Service<
  PageHost,
  {
    /** Serves `program` until the current scope closes. Closing it closes
     *  the page's live sessions and completes their snapshot writes. */
    readonly mount: <Model, Message, ClientMessage extends Message, Flags, R>(
      program: Program<Model, Message, ClientMessage, Flags, R>,
      options?: Options<R>,
    ) => Effect.Effect<void, PageConflict, Scope.Scope | R | KeyValueStore.KeyValueStore>
    /** Serves routes under a page's name until the current scope closes,
     *  as `mount` does for a program: for a page served elsewhere (another
     *  process), whose routes forward its requests. `drain` closes its live
     *  sessions with final snapshots when another version takes over. */
    readonly mountRoutes: (
      page: Readonly<{ name: string; routes: ReadonlyArray<PageRoute>; drain: Effect.Effect<void> }>,
    ) => Effect.Effect<void, PageConflict, Scope.Scope>
    /** The names of the pages served now, the newest of each name. */
    readonly names: Effect.Effect<ReadonlyArray<string>>
    /** The pages served now, with their paths and owners. */
    readonly pages: Effect.Effect<ReadonlyArray<HostedPage>>
  }
>()('@hyper-effect/core/PageHost') {}

const isRouteNotFound = (error: unknown): error is HttpServerError.HttpServerError =>
  HttpServerError.isHttpServerError(error) && error.reason._tag === 'RouteNotFound'

/** The page host, for an app's router: provide it to the layers that mount
 *  pages, inside `HttpRouter.serve`. */
export const pageHost: Layer.Layer<PageHost, never, HttpRouter.HttpRouter> = Layer.effect(
  PageHost,
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter
    let mounted: ReadonlyArray<Mounted> = []
    let nextId = 0
    let served: ReadonlyArray<Mounted> = []
    let handler: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, HttpRouter.GlobalProvided> | undefined

    /** The newest mount of each name, in mount order. */
    const newest = (all: ReadonlyArray<Mounted>): ReadonlyArray<Mounted> => {
      const byName = new Map<string, Mounted>()
      for (const entry of all) {
        byName.delete(entry.name)
        byName.set(entry.name, entry)
      }
      return [...byName.values()]
    }

    const gate = yield* Semaphore.make(GATE)

    /** Builds a router for `all` and serves it, or fails without changing
     *  what is served when two of its routes collide. The pages that stop
     *  serving a name another page serves now, or that stop serving, are
     *  drained first, while requests wait. */
    const serve = (all: ReadonlyArray<Mounted>) =>
      Effect.gen(function* () {
        const pages = newest(all)
        const next = yield* HttpRouter.make
        // The router throws on a collision; that arrives here as a defect.
        yield* next.addAll(pages.flatMap(page => page.routes)).pipe(
          Effect.catchCause(cause => Effect.fail(String(Cause.squash(cause)))),
        )
        const leaving = served.filter(page => !pages.some(other => other.id === page.id))
        yield* gate.withPermits(GATE)(
          Effect.gen(function* () {
            // A drain that fails leaves its sessions to the page's own close;
            // the switch happens either way.
            for (const page of leaving) {
              yield* page.drain.pipe(
                Effect.catchCause(cause => Effect.logWarning(`hyper-effect: page host: draining ${page.name} failed`, cause)),
              )
            }
            served = pages
            handler = next.asHttpEffect()
          }),
        )
      })

    /** A request to the pages: it waits while a hand-over runs. An event
     *  stream only waits (it stays open for the life of the page); other
     *  requests hold a permit until they are answered, so a hand-over waits
     *  for them. */
    const toPages = <E,>(error: E) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const run = Effect.suspend(() =>
          handler === undefined ? Effect.fail(error) : handler.pipe(Effect.catch(() => Effect.fail(error))),
        )
        if (new URL(request.url, 'http://localhost').pathname.endsWith('/stream')) {
          yield* gate.withPermits(1)(Effect.void)
          return yield* run
        }
        return yield* gate.withPermits(1)(run)
      })

    yield* serveDatastar(router)
    yield* router.addGlobalMiddleware(effect =>
      effect.pipe(
        // Page routes do not fail, so the host's router fails only when
        // none of its routes matched either: then the app's 404 stands.
        Effect.catchIf(isRouteNotFound, toPages),
      ),
    )

    const mountRoutes = (page: Readonly<{ name: string; routes: ReadonlyArray<PageRoute>; drain: Effect.Effect<void> }>) =>
        Effect.gen(function* () {
          const owner = yield* PageOwner
          const entry: Mounted = { id: nextId++, name: page.name, owner, routes: page.routes, drain: page.drain }
          yield* serve([...mounted, entry]).pipe(
            Effect.mapError(message => new PageConflict({ page: page.name, message })),
          )
          mounted = [...mounted, entry]
          // Runs before the page's own finalizers: requests stop reaching it,
          // then its sessions close.
          yield* Effect.addFinalizer(() =>
            Effect.suspend(() => {
              mounted = mounted.filter(other => other.id !== entry.id)
              // Revealing a shadowed page can collide with a page mounted
              // since. Then the pages served now, without this one, stay:
              // fewer routes than a working router never collide.
              return serve(mounted).pipe(
                Effect.catch(message =>
                  Effect.logWarning(`hyper-effect: page host: ${message}`).pipe(
                    Effect.andThen(serve(served.filter(other => other.id !== entry.id))),
                    Effect.ignore,
                  ),
                ),
              )
            }),
          )
        })

    return PageHost.of({
      mount: (program, options = {}) =>
        Effect.flatMap(servedPage(program, options), ({ routes, drain }) => mountRoutes({ name: program.name, routes, drain })),
      mountRoutes,
      names: Effect.sync(() => served.map(page => page.name)),
      pages: Effect.sync(() =>
        served.map(
          (page): HostedPage => ({
            name: page.name,
            paths: page.routes
              .filter(route => route.method === 'GET' && !String(route.path).startsWith('/_hyper/'))
              .map(route => String(route.path)),
            owner: page.owner,
          }),
        ),
      ),
    })
  }),
)
