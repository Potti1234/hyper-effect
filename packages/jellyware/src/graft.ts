import { Graft, type Mount } from '@graftland/graft'
import { Effect, type Fiber, type Layer, type Schedule, type Scope, type Stream } from 'effect'

/* The one module that imports Graft (`@graftland/graft`, pinned to 0.7.0).
   Everything else in jellyware goes through these few definitions, so a new
   Graft version, or our own replacement for the parts used here, changes
   this file only. See docs/jellyware/graft.md.

   Used from Graft: the graph (`Graft.layer`), mounting a layer for a scope
   with the services it requires, mount states, and background fibers whose
   failure fails the mount. */

/** The graph extensions are mounted in. Services in the environment where
 *  it is built (the app's stores, the page host) are visible to every
 *  extension. */
export const graph = Graft.layer

/** The graph, as a requirement of an Effect, and its service key. */
export type Graph = Graft.Graft
export const Graph = Graft.Graft

/** A service key an extension may require. */
export type Requirement = Graft.Dependency

/** The services a list of requirements stands for. */
export type Provided<Requires extends ReadonlyArray<Requirement>> = Graft.Required<Requires>

export type MountState = Mount.MountState

export type Mounted = Readonly<{
  /** The current state, then every change, ending with `Unmounted`. */
  state: Stream.Stream<MountState>
  /** Waits until the mount settles; fails with the build's cause when it
   *  ends up `Failed`. `Pending` (a required service missing) counts as
   *  settled. */
  settled: Effect.Effect<void, unknown>
}>

/** What a mounted layer may need besides its requirements: the graph and
 *  its background fibers (`background`). */
export type Mounting = Graft.Graft | Graft.Tasks<unknown>

/** Runs `effect` in the background of the layer being mounted: when it
 *  fails, the mount fails (and shows as failed), as a failed build does. */
export const background = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<Fiber.Fiber<A, E>, never, Exclude<R, Scope.Scope> | Graft.Graft | Graft.Tasks<E>> =>
  Graft.fork(effect)

/** Mounts `layer` for the current scope: it is built once every service in
 *  `requires` is available, and torn down when the scope closes or a
 *  required service goes away. */
export const mount = <const Requires extends ReadonlyArray<Requirement>>(
  layer: Layer.Layer<unknown, unknown, Provided<Requires> | Mounting>,
  options: Readonly<{ name: string; requires: Requires; retry?: Schedule.Schedule<unknown, unknown> }>,
): Effect.Effect<Mounted, never, Graph | Scope.Scope> =>
  Effect.map(
    Graft.mount(layer, {
      name: options.name,
      requires: options.requires,
      ...(options.retry === undefined ? {} : { retry: options.retry }),
    }),
    (mounted): Mounted => ({ state: mounted.state, settled: mounted.await }),
  )
