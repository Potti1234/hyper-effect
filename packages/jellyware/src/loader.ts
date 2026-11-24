import { watch } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  Cause,
  Clock,
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
import { KeyValueStore } from 'effect/persistence'

import { hashFolder, listFolders } from './files.ts'
import * as Graft from './graft.ts'
import {
  ExtensionSettings,
  SettingField,
  SettingSpec,
  type SettingValue,
  effectiveValues,
  makeSettings,
  parseInput,
} from './settings.ts'

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

   Settings work the same way: `configure` stores new values and loads the
   extension again with them. When the new version does not run, the old
   one keeps running and the old values are stored again; the change is
   recorded as reverted. Applied changes can be undone, newest first.

   Old generations stay in Node's module cache until the process restarts. */

export const Manifest = S.Struct({
  /** Equal to the folder name. */
  id: S.String,
  name: S.String,
  version: S.String,
  /** The entry module, relative to the folder. */
  entry: S.String,
  description: S.optional(S.String),
  /** What an administrator can change while the app runs. */
  settings: S.optional(S.Record(S.String, SettingSpec)),
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
  /** The declared settings with the values in effect. */
  settings: S.Array(SettingField),
})
export type ExtensionStatus = typeof ExtensionStatus.Type

const Values = S.Record(S.String, S.Union([S.String, S.Number, S.Boolean]))

export const SettingsChange = S.Struct({
  id: S.String,
  extension: S.String,
  author: S.String,
  at: S.Number,
  before: Values,
  after: Values,
  /** Applied; reverted because the extension did not run with it; or
   *  undone later. */
  state: S.Literals(['applied', 'reverted', 'undone']),
  error: S.NullOr(S.String),
})
export type SettingsChange = typeof SettingsChange.Type

export class Extensions extends Context.Service<
  Extensions,
  {
    /** The extensions now, then after every change, ordered by id. */
    readonly changes: Stream.Stream<ReadonlyArray<ExtensionStatus>>
    readonly current: Effect.Effect<ReadonlyArray<ExtensionStatus>>
    /** Loads the extension in folder `id` again: mounts its current files,
     *  or unloads it when its folder or manifest is gone. Files unchanged
     *  since the last attempt are not loaded again. */
    readonly reload: (id: string) => Effect.Effect<void>
    /** Changes settings of an extension (the form's text per key) and loads
     *  it with them; fails with a line for the member when a value does not
     *  fit. Answers with the recorded change, `reverted` when the extension
     *  did not run with the new values. */
    readonly configure: (id: string, input: Readonly<Record<string, string>>, author: string) => Effect.Effect<SettingsChange, string>
    /** Puts back the values before an applied change; only the newest
     *  applied change of an extension, and only while its values are still
     *  the ones it set. */
    readonly undoSettings: (changeId: string) => Effect.Effect<void, string>
    /** Settings changes, newest first, now and after every change. */
    readonly settingsChanges: Stream.Stream<ReadonlyArray<SettingsChange>>
    readonly currentSettingsChanges: Effect.Effect<ReadonlyArray<SettingsChange>>
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
): Layer.Layer<Extensions, never, Graft.Graph | KeyValueStore.KeyValueStore> =>
  Layer.effect(
    Extensions,
    Effect.gen(function* () {
      installHooks()
      const directory = resolve(options.directory)
      const lifetime = yield* Effect.scope
      const statuses = yield* SubscriptionRef.make<ReadonlyArray<ExtensionStatus>>([])
      const running = new Map<string, Readonly<{ generation: number; scope: Scope.Closeable }>>()
      /** The folder hash of each extension's last load attempt: a load of
       *  unchanged files (a watcher event for files the pipeline already
       *  loaded, a repeated reload) does nothing. */
      const attempted = new Map<string, string>()
      const lock = yield* Semaphore.make(1)
      // Only the graph: the layer's whole context would also carry its Scope.
      const graph = yield* Graft.Graph
      const store = yield* KeyValueStore.KeyValueStore
      const stored = KeyValueStore.prefix(store, 'jellyware/settings/')

      /** The narrowing an extension's own typecheck stands behind: its
       *  default export is declared against the app's host services and its
       *  settings. */
      const isExtensionLayer = (
        value: unknown,
      ): value is Layer.Layer<unknown, unknown, Graft.Provided<Requires> | ExtensionSettings> => Layer.isLayer(value)

      const decodeValues = S.decodeUnknownEffect(S.fromJsonString(Values))
      const readValues = (id: string) =>
        stored.get(id).pipe(
          Effect.flatMap(text => (text === undefined ? Effect.succeed({}) : decodeValues(text))),
          Effect.orElseSucceed((): Readonly<Record<string, SettingValue>> => ({})),
        )
      const writeValues = (id: string, values: Readonly<Record<string, SettingValue>>) =>
        stored.set(id, JSON.stringify(values)).pipe(Effect.orDie)
      const fieldsOf = (specs: Readonly<Record<string, SettingSpec>>, values: Readonly<Record<string, SettingValue>>) =>
        Object.entries(specs).map(([key, spec]): SettingField => ({ key, spec, value: values[key] ?? spec.default }))

      const setStatus = (status: ExtensionStatus) =>
        SubscriptionRef.update(statuses, list =>
          [...list.filter(other => other.id !== status.id), status].sort((a, b) => a.id.localeCompare(b.id)),
        )

      const unload = (id: string) =>
        Effect.gen(function* () {
          const previous = running.get(id)
          running.delete(id)
          attempted.delete(id)
          // The generation stays: a later load must not import a module URL
          // Node has cached from an earlier version.
          yield* SubscriptionRef.update(statuses, list => list.filter(other => other.id !== id))
          if (previous !== undefined) yield* Scope.close(previous.scope, Exit.void)
        })

      const load = (id: string) =>
        Effect.gen(function* () {
          const folder = join(directory, id)
          const manifestPath = join(folder, 'extension.json')
          if (!(yield* exists(manifestPath))) {
            if (running.has(id)) yield* Effect.logInfo(`jellyware: ${id} unloaded`)
            return yield* unload(id)
          }

          const text = yield* Effect.tryPromise({
            try: () => readFile(manifestPath, 'utf8'),
            catch: error => new LoadError({ message: `extension.json: ${String(error)}` }),
          })
          const manifest = yield* decodeManifest(text).pipe(
            Effect.mapError(error => new LoadError({ message: `extension.json: ${error.message}` })),
          )
          const specs = manifest.settings ?? {}
          const values = effectiveValues(specs, yield* readValues(id))
          const base = { id, name: manifest.name, version: manifest.version, settings: fieldsOf(specs, values) }
          const runningNow = () => running.get(id)?.generation ?? null
          // Files and settings: either changing loads the extension again.
          const hash = `${(yield* Effect.promise(() => hashFolder(folder))) ?? ''}:${JSON.stringify(values)}`
          if (attempted.get(id) === hash) return
          attempted.set(id, hash)
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
          const configured = extension.pipe(Layer.provide(Layer.succeed(ExtensionSettings, makeSettings(values))))
          const mounted = yield* Graft.mount(configured, { name: id, requires: options.requires }).pipe(
            Scope.provide(scope),
          )
          const settled = yield* Effect.exit(mounted.settled)
          if (Exit.isFailure(settled)) {
            yield* Scope.close(scope, Exit.void)
            yield* Effect.logWarning(`jellyware: ${id} generation ${generation} failed to build`, settled.cause)
            return yield* setStatus({ ...base, state: 'failed', running: runningNow(), error: describe(settled.cause) })
          }

          const previous = running.get(id)
          running.set(id, { generation, scope })
          if (previous !== undefined) yield* Scope.close(previous.scope, Exit.void)
          yield* Effect.logInfo(`jellyware: ${id} generation ${generation} is running`)

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
            Effect.logWarning(`jellyware: ${id}: ${error.message}`).pipe(
              Effect.andThen(SubscriptionRef.update(statuses, list => {
              const known = list.find(other => other.id === id)
              const status: ExtensionStatus = {
                id,
                name: known?.name ?? id,
                version: known?.version ?? '',
                state: 'failed',
                running: running.get(id)?.generation ?? null,
                error: error.message,
                settings: known?.settings ?? [],
              }
              return [...list.filter(other => other.id !== id), status].sort((a, b) => a.id.localeCompare(b.id))
            })),
            ),
          ),
          lock.withPermits(1),
        )

      const folders = yield* Effect.promise(() => listFolders(directory))
      for (const id of folders) yield* load(id)

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

      // SETTINGS CHANGES

      const decodeHistory = S.decodeUnknownEffect(S.fromJsonString(S.Array(SettingsChange)))
      const history = yield* SubscriptionRef.make<ReadonlyArray<SettingsChange>>(
        yield* store.get('jellyware/settings-history').pipe(
          Effect.flatMap(text => (text === undefined ? Effect.succeed([]) : decodeHistory(text))),
          Effect.orElseSucceed((): ReadonlyArray<SettingsChange> => []),
        ),
      )
      const record = (change: SettingsChange) =>
        Effect.gen(function* () {
          // A new change goes first; an undone one keeps its place.
          const all = yield* SubscriptionRef.get(history)
          const next = (
            all.some(other => other.id === change.id)
              ? all.map(other => (other.id === change.id ? change : other))
              : [change, ...all]
          ).slice(0, 100)
          yield* SubscriptionRef.set(history, next)
          yield* store.set('jellyware/settings-history', JSON.stringify(next)).pipe(Effect.orDie)
        })
      const settingsLock = yield* Semaphore.make(1)
      const loaded = (id: string) => load(id).pipe(Effect.provideService(Graft.Graph, graph))
      const errorOf = (id: string) =>
        Effect.map(SubscriptionRef.get(statuses), list => list.find(status => status.id === id)?.error ?? 'The extension did not load.')

      /** Stores `values`, loads the extension with them, and tells whether a
       *  new version runs; when not, the previous values are stored and
       *  loaded again. */
      const apply = (id: string, values: Readonly<Record<string, SettingValue>>, previous: Readonly<Record<string, SettingValue>>) =>
        Effect.gen(function* () {
          const before = running.get(id)?.generation ?? null
          yield* writeValues(id, values)
          yield* loaded(id)
          const after = running.get(id)?.generation ?? null
          if (after !== null && after !== before) return null
          const error = yield* errorOf(id)
          yield* writeValues(id, previous)
          yield* loaded(id)
          yield* Effect.logWarning(`jellyware: ${id}: settings put back, the extension did not run with them`)
          return error
        })

      const specsOf = (id: string) =>
        Effect.gen(function* () {
          const text = yield* Effect.promise(() => readFile(join(directory, id, 'extension.json'), 'utf8').catch(() => null))
          if (text === null) return yield* Effect.fail(`There is no extension ${id}.`)
          const manifest = yield* decodeManifest(text).pipe(Effect.mapError(() => `The manifest of ${id} is not valid.`))
          return manifest.settings ?? {}
        })

      return Extensions.of({
        changes: SubscriptionRef.changes(statuses),
        current: SubscriptionRef.get(statuses),
        reload: loaded,
        configure: (id, input, author) =>
          settingsLock.withPermits(1)(
            Effect.gen(function* () {
              const specs = yield* specsOf(id)
              const parsed = parseInput(specs, input)
              if ('errors' in parsed) return yield* Effect.fail(parsed.errors.join(' '))
              const before = effectiveValues(specs, yield* readValues(id))
              const after = { ...before, ...parsed.values }
              if (JSON.stringify(after) === JSON.stringify(before)) return yield* Effect.fail('Nothing changed.')
              const error = yield* apply(id, after, before)
              const change: SettingsChange = {
                id: `${yield* Clock.currentTimeMillis}-${Math.random().toString(36).slice(2, 6)}`,
                extension: id,
                author,
                at: yield* Clock.currentTimeMillis,
                before,
                after,
                state: error === null ? 'applied' : 'reverted',
                error,
              }
              yield* record(change)
              return change
            }),
          ),
        undoSettings: changeId =>
          settingsLock.withPermits(1)(
            Effect.gen(function* () {
              const all = yield* SubscriptionRef.get(history)
              const change = all.find(other => other.id === changeId)
              if (change === undefined) return yield* Effect.fail('There is no such change.')
              if (change.state !== 'applied') return yield* Effect.fail(`Only an applied change can be undone; this one is ${change.state}.`)
              const newer = all.find(other => other.extension === change.extension && other.state === 'applied' && other.at > change.at)
              if (newer !== undefined) return yield* Effect.fail('Undo the newer change of this extension first.')
              const specs = yield* specsOf(change.extension)
              const now = effectiveValues(specs, yield* readValues(change.extension))
              if (JSON.stringify(now) !== JSON.stringify(effectiveValues(specs, change.after))) {
                return yield* Effect.fail('The settings changed since; undo that first.')
              }
              const error = yield* apply(change.extension, effectiveValues(specs, change.before), now)
              if (error !== null) return yield* Effect.fail(`The extension did not run with the earlier settings: ${error}`)
              yield* record({ ...change, state: 'undone' })
            }),
          ),
        settingsChanges: SubscriptionRef.changes(history),
        currentSettingsChanges: SubscriptionRef.get(history),
      })
    }),
  )
