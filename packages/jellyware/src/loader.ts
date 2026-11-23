import { watch } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  Layer,
  Queue,
  Schema as S,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect'

import * as Graft from './graft.ts'

/* Loads the extensions in a folder, swaps each one when its files change,
   and unloads it when its folder goes.

   An extension is a folder `<directory>/<id>/` with an `extension.json`
   (`Manifest`) and an entry module whose default export is a Layer. The
   layer registers pages and contributions in its scope; everything it
   registered goes when it is unmounted.

   Swapping a version (after bb, see docs/jellyware/prior-art.md):
   1. The new version is imported under a new generation: a resolve hook
      adds `?jellyware=<generation>` to every file under the extension's
      folder, so Node imports the whole folder again while the app's own
      modules (and `effect`, `foldkit`, core) keep their single instance.
   2. It is mounted next to the old one. Its pages and contributions shadow
      the old version's (page host and Contributions keep a stack per id).
   3. Only when it settled is the old version unmounted. A version that
      fails to import or to build is unmounted again, and the old one keeps
      running.

   Old generations stay in Node's module cache until the process restarts. */

export const Manifest = S.Struct({
  /** Equal to the folder name. */
  id: S.String,
  name: S.String,
  version: S.String,
  /** The entry module, relative to the folder. */
  entry: S.String,
  description: S.optional(S.String),
})
export type Manifest = typeof Manifest.Type

export const ExtensionStatus = S.Struct({
  id: S.String,
  name: S.String,
  version: S.String,
  /** What happened to the latest version: being loaded, running, waiting
   *  for a service it requires, or failed (to import, to build, or later). */
  state: S.Literals(['loading', 'active', 'pending', 'failed']),
  /** The generation serving now; null while no version runs. */
  running: S.NullOr(S.Number),
  error: S.NullOr(S.String),
})
export type ExtensionStatus = typeof ExtensionStatus.Type

export class Extensions extends Context.Service<
  Extensions,
  {
    /** The extensions now, then after every change, ordered by id. */
    readonly changes: Stream.Stream<ReadonlyArray<ExtensionStatus>>
    readonly current: Effect.Effect<ReadonlyArray<ExtensionStatus>>
    /** Loads the extension in folder `id` again: mounts its current files,
     *  or unloads it when its folder or manifest is gone. */
    readonly reload: (id: string) => Effect.Effect<void>
  }
>()('@hyper-effect/jellyware/Extensions') {}

// MODULE GENERATIONS

/** Folder URL (with a trailing slash) to the generation imported last. */
const generations = new Map<string, number>()
let hooksInstalled = false

const installHooks = () => {
  if (hooksInstalled) return
  hooksInstalled = true
  registerHooks({
    resolve: (specifier, context, nextResolve) => {
      const resolved = nextResolve(specifier, context)
      if (!resolved.url.startsWith('file:')) return resolved
      const plain = resolved.url.split('?')[0] ?? resolved.url
      for (const [folder, generation] of generations) {
        if (plain.startsWith(folder)) return { ...resolved, url: `${plain}?jellyware=${generation}` }
      }
      return resolved
    },
  })
}

const folderUrl = (folder: string) => `${pathToFileURL(folder).href}/`

// LOADING

class LoadError extends Data.TaggedError('LoadError')<{ readonly message: string }> {}

const decodeManifest = S.decodeUnknownEffect(S.fromJsonString(Manifest))

const describe = (cause: Cause.Cause<unknown>) => Cause.pretty(cause).split('\n').slice(0, 12).join('\n')

const exists = (path: string) => Effect.promise(() => stat(path).then(() => true, () => false))

export type Options<Requires extends ReadonlyArray<Graft.Requirement>> = Readonly<{
  /** The folder holding one folder per extension. */
  directory: string
  /** The services extensions may use: every extension is mounted with this
   *  list, and is built once all of them are available. */
  requires: Requires
  /** Reload an extension when a file in its folder changes. */
  watch?: boolean
}>

/** Loads every extension in `options.directory` and keeps them loaded for
 *  the life of the layer. */
export const layer = <const Requires extends ReadonlyArray<Graft.Requirement>>(
  options: Options<Requires>,
): Layer.Layer<Extensions, never, Graft.Graph> =>
  Layer.effect(
    Extensions,
    Effect.gen(function* () {
      installHooks()
      const directory = resolve(options.directory)
      const lifetime = yield* Effect.scope
      const statuses = yield* SubscriptionRef.make<ReadonlyArray<ExtensionStatus>>([])
      const running = new Map<string, Readonly<{ generation: number; scope: Scope.Closeable }>>()
      const lock = yield* Semaphore.make(1)
      // Only the graph: the layer's whole context would also carry its Scope.
      const graph = yield* Graft.Graph

      /** The narrowing an extension's own typecheck stands behind: its
       *  default export is declared against the app's host services. */
      const isExtensionLayer = (value: unknown): value is Layer.Layer<unknown, unknown, Graft.Provided<Requires>> =>
        Layer.isLayer(value)

      const setStatus = (status: ExtensionStatus) =>
        SubscriptionRef.update(statuses, list =>
          [...list.filter(other => other.id !== status.id), status].sort((a, b) => a.id.localeCompare(b.id)),
        )

      const unload = (id: string) =>
        Effect.gen(function* () {
          const previous = running.get(id)
          running.delete(id)
          generations.delete(folderUrl(join(directory, id)))
          yield* SubscriptionRef.update(statuses, list => list.filter(other => other.id !== id))
          if (previous !== undefined) yield* Scope.close(previous.scope, Exit.void)
        })

      const load = (id: string) =>
        Effect.gen(function* () {
          const folder = join(directory, id)
          const manifestPath = join(folder, 'extension.json')
          if (!(yield* exists(manifestPath))) return yield* unload(id)

          const text = yield* Effect.tryPromise({
            try: () => readFile(manifestPath, 'utf8'),
            catch: error => new LoadError({ message: `extension.json: ${String(error)}` }),
          })
          const manifest = yield* decodeManifest(text).pipe(
            Effect.mapError(error => new LoadError({ message: `extension.json: ${error.message}` })),
          )
          const base = { id, name: manifest.name, version: manifest.version }
          const runningNow = () => running.get(id)?.generation ?? null
          if (manifest.id !== id) {
            return yield* setStatus({
              ...base,
              state: 'failed',
              running: runningNow(),
              error: `extension.json: id "${manifest.id}" differs from the folder name "${id}"`,
            })
          }
          yield* setStatus({ ...base, state: 'loading', running: runningNow(), error: null })

          const generation = (generations.get(folderUrl(folder)) ?? 0) + 1
          generations.set(folderUrl(folder), generation)
          const entry = `${pathToFileURL(join(folder, manifest.entry)).href}?jellyware=${generation}`
          const imported = yield* Effect.tryPromise({
            try: (): Promise<unknown> => import(entry),
            catch: error => new LoadError({ message: `Importing ${manifest.entry} failed: ${String(error)}` }),
          })
          const extension =
            typeof imported === 'object' && imported !== null && 'default' in imported ? imported.default : undefined
          if (!isExtensionLayer(extension)) {
            return yield* new LoadError({ message: `${manifest.entry} has no Layer as its default export` })
          }

          const scope = yield* Scope.fork(lifetime)
          const mounted = yield* Graft.mount(extension, { name: id, requires: options.requires }).pipe(
            Scope.provide(scope),
          )
          const settled = yield* Effect.exit(mounted.settled)
          if (Exit.isFailure(settled)) {
            yield* Scope.close(scope, Exit.void)
            return yield* setStatus({ ...base, state: 'failed', running: runningNow(), error: describe(settled.cause) })
          }

          const previous = running.get(id)
          running.set(id, { generation, scope })
          if (previous !== undefined) yield* Scope.close(previous.scope, Exit.void)

          const report = (state: Graft.MountState) =>
            state._tag === 'Unmounted' || state._tag === 'Loading'
              ? Effect.void
              : setStatus({
                  ...base,
                  state: state._tag === 'Active' ? 'active' : state._tag === 'Pending' ? 'pending' : 'failed',
                  running: generation,
                  error:
                    state._tag === 'Failed'
                      ? describe(state.cause)
                      : state._tag === 'Pending'
                        ? `Waiting for ${state.missing.join(', ')}`
                        : null,
                })
          const now = yield* Stream.runHead(mounted.state)
          if (now._tag === 'Some') yield* report(now.value)
          // Follow the mount for the life of this version: a required service
          // that goes, or a background failure, shows in the status.
          yield* mounted.state.pipe(Stream.runForEach(report), Effect.forkIn(scope))
        }).pipe(
          Effect.catchTag('LoadError', error =>
            SubscriptionRef.update(statuses, list => {
              const known = list.find(other => other.id === id)
              const status: ExtensionStatus = {
                id,
                name: known?.name ?? id,
                version: known?.version ?? '',
                state: 'failed',
                running: running.get(id)?.generation ?? null,
                error: error.message,
              }
              return [...list.filter(other => other.id !== id), status].sort((a, b) => a.id.localeCompare(b.id))
            }),
          ),
          lock.withPermits(1),
        )

      const folders = yield* Effect.promise(() =>
        readdir(directory, { withFileTypes: true }).then(
          entries => entries.filter(entry => entry.isDirectory()).map(entry => entry.name),
          () => [],
        ),
      )
      for (const id of folders.sort()) yield* load(id)

      if (options.watch === true) {
        const changed = yield* Queue.unbounded<string>()
        const watcher = yield* Effect.acquireRelease(
          Effect.sync(() =>
            watch(directory, { recursive: true }, (_event, filename) => {
              const id = filename?.toString().split(/[\\/]/)[0]
              if (id !== undefined && id !== '') Queue.offerUnsafe(changed, id)
            }),
          ),
          watcher => Effect.sync(() => watcher.close()),
        )
        void watcher
        // Editors write a file in several steps: wait until the folder has
        // been quiet for 300 ms, then reload every extension that changed.
        yield* Effect.gen(function* () {
          const first = yield* Queue.take(changed)
          const ids = new Set([first])
          while (true) {
            const more = yield* Queue.take(changed).pipe(Effect.timeoutOption('300 millis'))
            if (more._tag === 'None') break
            ids.add(more.value)
          }
          for (const id of ids) yield* load(id)
        }).pipe(Effect.forever, Effect.forkScoped)
      }

      return Extensions.of({
        changes: SubscriptionRef.changes(statuses),
        current: SubscriptionRef.get(statuses),
        reload: id => load(id).pipe(Effect.provideService(Graft.Graph, graph)),
      })
    }),
  )
