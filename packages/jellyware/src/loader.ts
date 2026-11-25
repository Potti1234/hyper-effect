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
  type Redacted,
  Schema as S,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect'
import { KeyValueStore } from 'effect/persistence'

import { hashFolder, listFolders } from './files.ts'
import { PageOwner } from '@hyper-effect/core'

import { CurrentExtension } from './contributions.ts'
import { DataError, type Database, DataSummary, ExtensionData, applyMigrations, makeData, openDatabase, summarize } from './data.ts'
import * as Graft from './graft.ts'
import { type IsolationOptions, isolatedExtension } from './isolation/parent.ts'
import { decrypt, encrypt, isStoredSecret, maskSecret } from './secrets.ts'
import {
  ExtensionSettings,
  SettingField,
  SettingSpec,
  type SettingValue,
  type SettingValues,
  effectiveValues,
  fits,
  isMemberSetting,
  makeSettings,
  parseInput,
  valuesOf,
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
   Secrets are stored encrypted with `secretKey` and leave the loader only
   as `Redacted` values for the extension: statuses and the history show
   them as set or not set. A member's own values of member settings are
   kept apart (`configureMember`) and reach the running extension through
   `ExtensionSettings.forMember`, without a new build.

   An extension can be turned off (`setEnabled`): it is unloaded and stays
   unloaded, across restarts and changes of its files, until it is turned on
   again. Its folder, settings and data stay.

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
  /** The SQL statements that make its tables, append-only (data.ts). */
  migrations: S.optional(S.Array(S.String)),
})
export type Manifest = typeof Manifest.Type

export const ExtensionStatus = S.Struct({
  id: S.String,
  name: S.String,
  version: S.String,
  /** What happened to the latest version: being loaded, running, waiting
   *  for a service it requires, failed (to import, to build, or later), or
   *  turned off. */
  state: S.Literals(['loading', 'active', 'pending', 'failed', 'disabled']),
  /** The generation serving now; null while no version runs. */
  running: S.NullOr(S.Number),
  /** From the manifest. */
  description: S.NullOr(S.String).pipe(S.withDecodingDefaultKey(Effect.succeed(null))),
  /** Whether it runs in a process of its own. */
  isolated: S.Boolean.pipe(S.withDecodingDefaultKey(Effect.succeed(false))),
  /** Its database's tables, when it has any. */
  data: S.NullOr(DataSummary).pipe(S.withDecodingDefaultKey(Effect.succeed(null))),
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
    /** Clears secrets of an extension (keys of secret settings) and loads it
     *  again, as `configure` does. */
    readonly clearSecrets: (id: string, keys: ReadonlyArray<string>, author: string) => Effect.Effect<SettingsChange, string>
    /** The member settings of every extension as `memberId` has them, now
     *  and after every change. */
    readonly memberSettings: (memberId: string) => Stream.Stream<ReadonlyArray<MemberSettings>>
    /** Sets a member's own values (the form's text per key) of member
     *  settings; fails with a line for the member when one does not fit. */
    readonly configureMember: (id: string, memberId: string, input: Readonly<Record<string, string>>) => Effect.Effect<void, string>
    /** Puts a member back on the defaults of an extension's settings. */
    readonly resetMember: (id: string, memberId: string) => Effect.Effect<void>
    /** Turns an extension off (unloads it until it is turned on) or on
     *  (loads it again); fails with a line for the member when there is no
     *  such extension. */
    readonly setEnabled: (id: string, enabled: boolean) => Effect.Effect<void, string>
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
  /** Encrypts secret settings at rest. Without it, secrets cannot be set. */
  secretKey?: Redacted.Redacted<string>
  /** Runs every extension in a process of its own (isolation/parent.ts);
   *  without it, extensions run in this process. */
  isolation?: IsolationOptions
  /** Where each extension's database is kept (data.ts); without it,
   *  extensions with migrations do not load. */
  dataDirectory?: string
}>

/** The member settings of one extension as one member has them: `fields`
 *  hold the member's values (their own or the default), `own` the keys
 *  they set themselves. */
export const MemberSettings = S.Struct({
  extension: S.String,
  name: S.String,
  fields: S.Array(SettingField),
  own: S.Array(S.String),
})
export type MemberSettings = typeof MemberSettings.Type

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
      // The extensions turned off, by id.
      const decodeIds = S.decodeUnknownEffect(S.fromJsonString(S.Array(S.String)))
      const disabled = new Set(
        yield* store.get('jellyware/disabled').pipe(
          Effect.flatMap(text => (text === undefined ? Effect.succeed([]) : decodeIds(text))),
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        ),
      )

      /** The narrowing an extension's own typecheck stands behind: its
       *  default export is declared against the app's host services and its
       *  settings. */
      const isExtensionLayer = (
        value: unknown,
      ): value is Layer.Layer<unknown, unknown, Graft.Provided<Requires> | ExtensionSettings | ExtensionData | Graft.Mounting> =>
        Layer.isLayer(value)

      // Each extension's database, open for the life of the loader.
      const databases = new Map<string, Database>()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const database of databases.values()) database.db.close()
          databases.clear()
        }),
      )
      /** An extension's database, when it declares migrations or has one. */
      const databaseOf = (id: string, wanted: boolean) =>
        Effect.gen(function* () {
          const open = databases.get(id)
          if (open !== undefined) return open
          if (options.dataDirectory === undefined) return null
          if (!wanted && !(yield* exists(join(options.dataDirectory, `${id}.sqlite`)))) return null
          const database = yield* openDatabase(options.dataDirectory, id)
          databases.set(id, database)
          return database
        })
      const noTables = 'This extension has no tables: declare them as migrations in extension.json.'
      const noData = ExtensionData.of({
        query: () => Effect.fail(new DataError({ message: noTables })),
        run: () => Effect.fail(new DataError({ message: noTables })),
        changes: Stream.make(0),
      })

      const decodeValues = S.decodeUnknownEffect(S.fromJsonString(Values))
      const readValues = (id: string) =>
        stored.get(id).pipe(
          Effect.flatMap(text => (text === undefined ? Effect.succeed({}) : decodeValues(text))),
          Effect.orElseSucceed((): Readonly<Record<string, SettingValue>> => ({})),
        )
      const writeValues = (id: string, values: Readonly<Record<string, SettingValue>>) =>
        stored.set(id, JSON.stringify(values)).pipe(Effect.orDie)
      /** The fields a page may show: secrets as set or not set. */
      const fieldsOf = (specs: Readonly<Record<string, SettingSpec>>, values: Readonly<Record<string, SettingValue>>) =>
        Object.entries(specs).map(
          ([key, spec]): SettingField =>
            spec.type === 'secret'
              ? { key, spec, value: '', isSet: (values[key] ?? '') !== '' }
              : { key, spec, value: values[key] ?? ('default' in spec ? spec.default : ''), isSet: true },
        )

      // Members' own values: extension id -> member id -> values.
      type MemberValues = Readonly<Record<string, Readonly<Record<string, unknown>>>>
      const memberStored = KeyValueStore.prefix(store, 'jellyware/member-settings/')
      const memberValues = yield* SubscriptionRef.make<Readonly<Record<string, MemberValues>>>({})
      const decodeMemberValues = S.decodeUnknownEffect(S.fromJsonString(S.Record(S.String, S.Record(S.String, S.Unknown))))
      /** Reads an extension's member values from the store once. */
      const ensureMemberValues = (id: string) =>
        Effect.gen(function* () {
          if (id in (yield* SubscriptionRef.get(memberValues))) return
          const read = yield* memberStored.get(id).pipe(
            Effect.flatMap(text => (text === undefined ? Effect.succeed({}) : decodeMemberValues(text))),
            Effect.orElseSucceed((): MemberValues => ({})),
          )
          yield* SubscriptionRef.update(memberValues, all => (id in all ? all : { ...all, [id]: read }))
        })
      const writeMemberValues = (id: string, values: MemberValues) =>
        Effect.gen(function* () {
          yield* SubscriptionRef.update(memberValues, all => ({ ...all, [id]: values }))
          yield* memberStored.set(id, JSON.stringify(values)).pipe(Effect.orDie)
        })
      /** A member's own values that are member settings and fit. */
      const ownValues = (specs: Readonly<Record<string, SettingSpec>>, own: Readonly<Record<string, unknown>>) => {
        const values: Record<string, SettingValue> = {}
        for (const [key, value] of Object.entries(own)) {
          const spec = specs[key]
          if (spec === undefined || !isMemberSetting(spec) || fits(spec, value) !== null) continue
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') values[key] = value
        }
        return values
      }

      /** The secrets of `values`, opened; a secret the key cannot open is
       *  given as not set. */
      const openSecrets = (id: string, specs: Readonly<Record<string, SettingSpec>>, values: Readonly<Record<string, SettingValue>>) =>
        Effect.gen(function* () {
          const secrets: Record<string, string> = {}
          for (const [key, spec] of Object.entries(specs)) {
            if (spec.type !== 'secret') continue
            const stored = values[key]
            if (typeof stored !== 'string' || stored === '') continue
            const plain = options.secretKey === undefined ? null : decrypt(options.secretKey, stored)
            if (plain === null) yield* Effect.logWarning(`jellyware: ${id}: the secret ${key} cannot be read with this key; it is given as not set`)
            else secrets[key] = plain
          }
          return secrets
        })

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
          yield* ensureMemberValues(id)
          // Turned off: unloaded, but listed with what it would have.
          if (disabled.has(id)) {
            const previous = running.get(id)
            running.delete(id)
            attempted.delete(id)
            if (previous !== undefined) {
              yield* Scope.close(previous.scope, Exit.void)
              yield* Effect.logInfo(`jellyware: ${id} turned off`)
            }
            const existing = yield* databaseOf(id, false)
            const summary = existing === null ? null : summarize(existing.db)
            return yield* setStatus({
              id,
              name: manifest.name,
              version: manifest.version,
              description: manifest.description ?? null,
              isolated: options.isolation !== undefined,
              data: summary !== null && (summary.migrations > 0 || summary.tables.length > 0) ? summary : null,
              settings: fieldsOf(specs, values),
              state: 'disabled',
              running: null,
              error: null,
            })
          }
          // Its database: new migrations first; one that is changed or fails
          // stops the load.
          const migrations = manifest.migrations ?? []
          const database = yield* databaseOf(id, migrations.length > 0)
          if (migrations.length > 0 && database === null) {
            return yield* new LoadError({ message: 'It declares migrations, but this app keeps no data for extensions.' })
          }
          const migrationProblem = database === null || migrations.length === 0 ? null : applyMigrations(database.db, migrations)
          if (migrationProblem !== null) return yield* new LoadError({ message: `extension.json: ${migrationProblem}` })
          const data = database === null ? null : summarize(database.db)
          const base = {
            id,
            name: manifest.name,
            version: manifest.version,
            description: manifest.description ?? null,
            isolated: options.isolation !== undefined,
            data: data !== null && (data.migrations > 0 || data.tables.length > 0) ? data : null,
            settings: fieldsOf(specs, values),
          }
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
          // Its settings (secrets opened; member values read while it runs).
          const plain = Object.fromEntries(Object.entries(values).filter(([key]) => specs[key]?.type !== 'secret'))
          const secrets = yield* openSecrets(id, specs, values)
          // In a process of its own (a new one per version), or imported
          // into this one under a new generation.
          const extension = yield* options.isolation !== undefined
            ? Effect.succeed(
                isolatedExtension({ id, entry: join(folder, manifest.entry), values: plain, secrets, options: options.isolation }),
              )
            : Effect.gen(function* () {
                const entry = `${pathToFileURL(join(folder, manifest.entry)).href}?jellyware=${generation}`
                const imported = yield* Effect.tryPromise({
                  try: (): Promise<unknown> => import(entry),
                  catch: error => new LoadError({ message: `Importing ${manifest.entry} failed: ${String(error)}` }),
                })
                return typeof imported === 'object' && imported !== null && 'default' in imported ? imported.default : undefined
              })
          if (!isExtensionLayer(extension)) {
            return yield* new LoadError({ message: `${manifest.entry} has no Layer as its default export` })
          }

          const scope = yield* Scope.fork(lifetime)
          // Its id as the owner of what it registers.
          const forMember = (memberId: string): Stream.Stream<SettingValues> =>
            SubscriptionRef.changes(memberValues).pipe(
              Stream.map(all => ownValues(specs, all[id]?.[memberId] ?? {})),
              Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
              Stream.map(own => valuesOf({ ...plain, ...own })),
            )
          const configured = extension.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ExtensionSettings, makeSettings(plain, secrets, forMember)),
                Layer.succeed(ExtensionData, database === null ? noData : makeData(database)),
                Layer.succeed(CurrentExtension, id),
                Layer.succeed(PageOwner, id),
              ),
            ),
          )
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
                description: known?.description ?? null,
                isolated: options.isolation !== undefined,
                data: known?.data ?? null,
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
      /** A change as pages see it: stored secrets as a short mark. */
      const masked = (change: SettingsChange): SettingsChange => {
        const secretKeys = new Set(
          [...Object.entries(change.before), ...Object.entries(change.after)].filter(([, value]) => isStoredSecret(value)).map(([key]) => key),
        )
        const mask = (values: Readonly<Record<string, SettingValue>>) =>
          Object.fromEntries(
            Object.entries(values).map(([key, value]) => [key, secretKeys.has(key) && typeof value === 'string' ? maskSecret(value) : value]),
          )
        return secretKeys.size === 0 ? change : { ...change, before: mask(change.before), after: mask(change.after) }
      }
      // One masked list per history, shared by every page that follows it.
      let lastHistory: ReadonlyArray<SettingsChange> | null = null
      let lastMasked: ReadonlyArray<SettingsChange> = []
      const maskedHistory = (list: ReadonlyArray<SettingsChange>) => {
        if (list !== lastHistory) {
          lastHistory = list
          lastMasked = list.map(masked)
        }
        return lastMasked
      }

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

      /** Stores `next(before)` as an extension's values, loads it, and
       *  records the change. */
      const change = (
        id: string,
        author: string,
        next: (specs: Readonly<Record<string, SettingSpec>>, before: Readonly<Record<string, SettingValue>>) => Effect.Effect<Readonly<Record<string, SettingValue>>, string>,
      ) =>
        settingsLock.withPermits(1)(
          Effect.gen(function* () {
            const specs = yield* specsOf(id)
            const before = effectiveValues(specs, yield* readValues(id))
            const after = yield* next(specs, before)
            if (JSON.stringify(after) === JSON.stringify(before)) return yield* Effect.fail('Nothing changed.')
            const error = yield* apply(id, after, before)
            const recorded: SettingsChange = {
              id: `${yield* Clock.currentTimeMillis}-${Math.random().toString(36).slice(2, 6)}`,
              extension: id,
              author,
              at: yield* Clock.currentTimeMillis,
              before,
              after,
              state: error === null ? 'applied' : 'reverted',
              error,
            }
            yield* record(recorded)
            return masked(recorded)
          }),
        )

      return Extensions.of({
        changes: SubscriptionRef.changes(statuses),
        current: SubscriptionRef.get(statuses),
        reload: loaded,
        configure: (id, input, author) =>
          change(id, author, (specs, before) =>
            Effect.gen(function* () {
              const parsed = parseInput(specs, input)
              if ('errors' in parsed) return yield* Effect.fail(parsed.errors.join(' '))
              const values: Record<string, SettingValue> = { ...before }
              for (const [key, value] of Object.entries(parsed.values)) {
                if (specs[key]?.type !== 'secret') {
                  values[key] = value
                  continue
                }
                if (options.secretKey === undefined) {
                  return yield* Effect.fail('Secret settings need a key: the app must give the loader a secretKey.')
                }
                values[key] = encrypt(options.secretKey, String(value))
              }
              return values
            }),
          ),
        clearSecrets: (id, keys, author) =>
          change(id, author, (specs, before) =>
            Effect.gen(function* () {
              const values: Record<string, SettingValue> = { ...before }
              for (const key of keys) {
                if (specs[key]?.type !== 'secret') return yield* Effect.fail(`"${key}" is not a secret setting of this extension.`)
                values[key] = ''
              }
              return values
            }),
          ),
        memberSettings: memberId =>
          Stream.zipLatest(SubscriptionRef.changes(statuses), SubscriptionRef.changes(memberValues)).pipe(
            Stream.map(([list, all]) =>
              list.flatMap((status): ReadonlyArray<MemberSettings> => {
                const fields = status.settings.filter(field => isMemberSetting(field.spec))
                if (fields.length === 0) return []
                const specs = Object.fromEntries(fields.map(field => [field.key, field.spec]))
                const own = ownValues(specs, all[status.id]?.[memberId] ?? {})
                return [
                  {
                    extension: status.id,
                    name: status.name,
                    fields: fields.map(field => ({ ...field, value: own[field.key] ?? field.value })),
                    own: Object.keys(own),
                  },
                ]
              }),
            ),
            Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
          ),
        configureMember: (id, memberId, input) =>
          Effect.gen(function* () {
            const all = yield* specsOf(id)
            const specs = Object.fromEntries(Object.entries(all).filter(([, spec]) => isMemberSetting(spec)))
            const parsed = parseInput(specs, input)
            if ('errors' in parsed) return yield* Effect.fail(parsed.errors.join(' '))
            yield* ensureMemberValues(id)
            const current = (yield* SubscriptionRef.get(memberValues))[id] ?? {}
            yield* writeMemberValues(id, { ...current, [memberId]: { ...ownValues(specs, current[memberId] ?? {}), ...parsed.values } })
          }),
        setEnabled: (id, enabled) =>
          settingsLock.withPermits(1)(
            Effect.gen(function* () {
              yield* specsOf(id)
              if (enabled === !disabled.has(id)) return
              if (enabled) disabled.delete(id)
              else disabled.add(id)
              yield* store.set('jellyware/disabled', JSON.stringify([...disabled].sort())).pipe(Effect.orDie)
              yield* loaded(id)
            }),
          ),
        resetMember: (id, memberId) =>
          Effect.gen(function* () {
            yield* ensureMemberValues(id)
            const current = (yield* SubscriptionRef.get(memberValues))[id] ?? {}
            if (!(memberId in current)) return
            const { [memberId]: _, ...rest } = current
            yield* writeMemberValues(id, rest)
          }),
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
        settingsChanges: SubscriptionRef.changes(history).pipe(Stream.map(maskedHistory)),
        currentSettingsChanges: Effect.map(SubscriptionRef.get(history), maskedHistory),
      })
    }),
  )
