import { Cause, Context, Data, Effect, Layer, type Scope } from 'effect'
import { HttpRouter, HttpServerError, type HttpServerResponse } from 'effect/http'
import type { KeyValueStore } from 'effect/persistence'

import type { Program } from './program.ts'
import { pageRoutes, serveDatastar, type Options, type PageRoute } from './server.ts'

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
   old one, whose live sessions close and write their snapshots; their
   browsers reconnect and the new page restores them. */

/** Mounting failed because a route of the page collides with a route of
 *  another mounted page (the same path pattern under a different name). */
export class PageConflict extends Data.TaggedError('PageConflict')<{
  /** The name of the page that was refused. */
  readonly page: string
  readonly message: string
}> {}

type Mounted = Readonly<{ id: number; name: string; routes: ReadonlyArray<PageRoute> }>

export class PageHost extends Context.Service<
  PageHost,
  {
    /** Serves `program` until the current scope closes. Closing it closes
     *  the page's live sessions and completes their snapshot writes. */
    readonly mount: <Model, Message, ClientMessage extends Message, Flags, R>(
      program: Program<Model, Message, ClientMessage, Flags, R>,
      options?: Options<R>,
    ) => Effect.Effect<void, PageConflict, Scope.Scope | R | KeyValueStore.KeyValueStore>
    /** The names of the pages served now, the newest of each name. */
    readonly names: Effect.Effect<ReadonlyArray<string>>
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

    /** Builds a router for `all` and serves it, or fails without changing
     *  what is served when two of its routes collide. */
    const serve = (all: ReadonlyArray<Mounted>) =>
      Effect.gen(function* () {
        const pages = newest(all)
        const next = yield* HttpRouter.make
        // The router throws on a collision; that arrives here as a defect.
        yield* next.addAll(pages.flatMap(page => page.routes)).pipe(
          Effect.catchCause(cause => Effect.fail(String(Cause.squash(cause)))),
        )
        served = pages
        handler = next.asHttpEffect()
      })

    yield* serveDatastar(router)
    yield* router.addGlobalMiddleware(effect =>
      effect.pipe(
        // Page routes do not fail, so the host's router fails only when
        // none of its routes matched either: then the app's 404 stands.
        Effect.catchIf(isRouteNotFound, error =>
          handler === undefined ? Effect.fail(error) : handler.pipe(Effect.catch(() => Effect.fail(error))),
        ),
      ),
    )

    return PageHost.of({
      mount: (program, options = {}) =>
        Effect.gen(function* () {
          const routes = yield* pageRoutes(program, options)
          const entry: Mounted = { id: nextId++, name: program.name, routes }
          yield* serve([...mounted, entry]).pipe(
            Effect.mapError(message => new PageConflict({ page: program.name, message })),
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
        }),
      names: Effect.sync(() => served.map(page => page.name)),
    })
  }),
)
