import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { Clock, Context, Data, Effect, Layer, Queue, Schema as S, Semaphore, type Stream, SubscriptionRef } from 'effect'

import { type FileDiff, diffFolders } from './diff.ts'
import { copyFolder, hashFolder, listFiles, listFolders, mirrorFolder } from './files.ts'
import { Extensions, Manifest } from './loader.ts'

/* Changes to a running app's extensions, made by an agent from a prompt,
   checked before they go live, and undone per run. After Powermove's
   pipeline (docs/jellyware/prior-art.md#agent-pipeline):

   1. Stage: the extensions folder is copied into the run's folder; the agent
      works on that copy only.
   2. Snapshot: when the agent is done, the stage is copied once more. Every
      check and the install use this copy, so what was checked is what goes
      live.
   3. Check: manifests, a scan for credentials, and the app's checks (its
      typecheck). A failure goes back to the agent, a limited number of times.
   4. Install: refused if a live extension changed since the stage was made.
      The live folders of the changed extensions are copied to `before/`
      (the journal), then made equal to the snapshot, then loaded. An
      extension that fails to build is put back, and the failure goes back
      to the agent like a failed check.
      With `review` on, a run whose checks pass waits in `review` instead:
      the live folders are copied to `before/` at once, `diff` shows what
      would change, and a person approves (install as above) or rejects it.
      An extension that fails to build at approval is put back and the run
      fails; the agent is done by then.
   5. Record: the run keeps, per extension, the hash before and after. Undo
      puts `before/` back, only while the live folder still has the hash the
      run produced; otherwise newer runs must be undone first.

   A run interrupted while installing is put back when the app starts; a
   run waiting for review keeps waiting. Runs are kept in `<workDirectory>/runs/<id>/run.json`. */

export const ChangeAction = S.Literals(['added', 'changed', 'removed'])

export const ChangedExtension = S.Struct({
  id: S.String,
  action: ChangeAction,
  /** Folder hashes before and after the run; null where it does not exist. */
  before: S.NullOr(S.String),
  after: S.NullOr(S.String),
})
export type ChangedExtension = typeof ChangedExtension.Type

export const RunState = S.Literals([
  'queued',
  'working',
  'checking',
  'review',
  'installing',
  'installed',
  'unchanged',
  'failed',
  'rejected',
  'undone',
])
export type RunState = typeof RunState.Type

export const Run = S.Struct({
  id: S.String,
  prompt: S.String,
  author: S.String,
  startedAt: S.Number,
  finishedAt: S.NullOr(S.Number),
  state: RunState,
  /** How many times the agent worked on it (the first time and retries). */
  attempts: S.Number,
  changes: S.Array(ChangedExtension),
  /** The agent's last answer. */
  summary: S.NullOr(S.String),
  error: S.NullOr(S.String),
  /** Who approved or rejected it; null without review. */
  reviewer: S.NullOr(S.String).pipe(S.withDecodingDefaultKey(Effect.succeed(null))),
})
export type Run = typeof Run.Type

/** The agent failed to work (not: its result failed a check). */
export class AgentError extends Data.TaggedError('AgentError')<{ readonly message: string }> {}

export type Task = Readonly<{
  prompt: string
  /** The folder the agent works in: a copy of the extensions folder. */
  stage: string
  /** The run's own folder, for the agent's session and files. */
  runDirectory: string
  /** What failed after the agent's previous attempt; null on the first. */
  feedback: string | null
}>

/** Works on the stage until it is done; answers with a summary. */
export type Agent = Readonly<{ work: (task: Task) => Effect.Effect<string, AgentError> }>

/** A check of the snapshot, such as a typecheck: fails with what to fix. */
export type Check = Readonly<{
  name: string
  run: (input: Readonly<{ snapshot: string; runDirectory: string; changed: ReadonlyArray<string> }>) => Effect.Effect<void, string>
}>

export class UndoRefused extends Data.TaggedError('UndoRefused')<{ readonly message: string }> {}

/** An approval, rejection or diff asked for a run that does not have one. */
export class ReviewRefused extends Data.TaggedError('ReviewRefused')<{ readonly message: string }> {}

export class Changes extends Context.Service<
  Changes,
  {
    /** The runs, newest first, now and after every change. */
    readonly changes: Stream.Stream<ReadonlyArray<Run>>
    readonly current: Effect.Effect<ReadonlyArray<Run>>
    /** Queues a run; runs go one at a time. Answers with its id. */
    readonly start: (prompt: string, author: string) => Effect.Effect<string>
    readonly undo: (runId: string) => Effect.Effect<void, UndoRefused>
    /** Installs a run waiting for review. The run then is `installed`, or
     *  `failed` when a live extension changed meanwhile or an extension
     *  fails to build (put back). */
    readonly approve: (runId: string, reviewer: string) => Effect.Effect<void, ReviewRefused>
    readonly reject: (runId: string, reviewer: string) => Effect.Effect<void, ReviewRefused>
    /** What a run changes (in review) or changed: the live files before it
     *  against its snapshot. */
    readonly diff: (runId: string) => Effect.Effect<ReadonlyArray<FileDiff>, ReviewRefused>
  }
>()('@hyper-effect/jellyware/Changes') {}

export type Options = Readonly<{
  /** The live extensions folder the loader watches. */
  extensionsDirectory: string
  /** Where runs keep their stages, snapshots and journals. */
  workDirectory: string
  agent: Agent
  checks: ReadonlyArray<Check>
  /** Folders the agent must not change (the app's own sources); a run that
   *  changed them fails. */
  protectedDirectories?: ReadonlyArray<string>
  /** How often the agent may work on one run, retries included. Default 3. */
  attempts?: number
  /** Whether a checked run waits for a person to approve it. Default
   *  false: it installs at once. */
  review?: boolean
}>

// CHECKS EVERY RUN GETS

const decodeManifest = S.decodeUnknownEffect(S.fromJsonString(Manifest))

const SECRETS = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
]

const checkManifest = (snapshot: string, id: string) =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() => readFile(join(snapshot, id, 'extension.json'), 'utf8').catch(() => null))
    if (text === null) return yield* Effect.fail(`${id}/extension.json is missing.`)
    const manifest = yield* decodeManifest(text).pipe(Effect.mapError(error => `${id}/extension.json: ${error.message}`))
    if (manifest.id !== id) return yield* Effect.fail(`${id}/extension.json: "id" must be "${id}", the folder name.`)
    const entry = yield* Effect.promise(() => stat(join(snapshot, id, manifest.entry)).then(info => info.isFile(), () => false))
    if (!entry) return yield* Effect.fail(`${id}/extension.json: the entry "${manifest.entry}" does not exist.`)
  })

const scanForSecrets = (snapshot: string, id: string) =>
  Effect.gen(function* () {
    const folder = join(snapshot, id)
    for (const file of yield* Effect.promise(() => listFiles(folder))) {
      const text = yield* Effect.promise(() => readFile(join(folder, file), 'utf8'))
      if (SECRETS.some(pattern => pattern.test(text))) {
        return yield* Effect.fail(`${id}/${file} looks like it contains a credential. Extensions must not contain secrets.`)
      }
    }
  })

// THE PIPELINE

type Hashes = ReadonlyMap<string, string | null>

const hashesOf = (directory: string, ids: Iterable<string>) =>
  Effect.promise(async () => {
    const hashes = new Map<string, string | null>()
    for (const id of ids) hashes.set(id, await hashFolder(join(directory, id)))
    return hashes
  })

const hashTree = (directories: ReadonlyArray<string>) =>
  Effect.promise(async () => (await Promise.all(directories.map(hashFolder))).join(','))

const encodeRun = S.encodeEffect(S.fromJsonString(Run))
const decodeRun = S.decodeUnknownEffect(S.fromJsonString(Run))

/** The change pipeline for the extensions the loader (`Extensions`) runs. */
export const layer = (options: Options): Layer.Layer<Changes, never, Extensions> =>
  Layer.effect(
    Changes,
    Effect.gen(function* () {
      const extensions = yield* Extensions
      const live = resolve(options.extensionsDirectory)
      const work = resolve(options.workDirectory)
      const runsDirectory = join(work, 'runs')
      const maxAttempts = options.attempts ?? 3
      const protectedDirectories = (options.protectedDirectories ?? []).map(directory => resolve(directory))
      yield* Effect.promise(() => mkdir(runsDirectory, { recursive: true }))

      const runs = yield* SubscriptionRef.make<ReadonlyArray<Run>>([])
      const installLock = yield* Semaphore.make(1)
      const directoryOf = (id: string) => join(runsDirectory, id)

      const FINAL: ReadonlySet<RunState> = new Set(['installed', 'unchanged', 'failed', 'rejected', 'undone'])
      const save = (next: Run) =>
        Effect.gen(function* () {
          const run =
            next.finishedAt === null && FINAL.has(next.state)
              ? { ...next, finishedAt: yield* Clock.currentTimeMillis }
              : next
          const json = yield* encodeRun(run).pipe(Effect.orDie)
          yield* Effect.promise(() => writeFile(join(directoryOf(run.id), 'run.json'), json))
          yield* SubscriptionRef.update(runs, list =>
            [run, ...list.filter(other => other.id !== run.id)].sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id)),
          )
        })

      const reloadAll = (ids: Iterable<string>) => Effect.forEach([...ids], id => extensions.reload(id), { discard: true })

      /** Puts the `before/` copies of `changes` back and loads them. */
      const restore = (run: Run, changes: ReadonlyArray<ChangedExtension>) =>
        Effect.gen(function* () {
          for (const change of changes) {
            yield* Effect.promise(() => mirrorFolder(join(directoryOf(run.id), 'before', change.id), join(live, change.id)))
          }
          yield* reloadAll(changes.map(change => change.id))
        })

      // Runs interrupted while installing: put back what they changed.
      for (const id of yield* Effect.promise(() => listFolders(runsDirectory))) {
        const text = yield* Effect.promise(() => readFile(join(directoryOf(id), 'run.json'), 'utf8').catch(() => null))
        if (text === null) continue
        const decoded = yield* decodeRun(text).pipe(Effect.option)
        if (decoded._tag === 'None') continue
        let run = decoded.value
        if (run.state === 'installing') {
          yield* restore(run, run.changes)
          run = { ...run, state: 'failed', error: 'Interrupted while installing; the extensions were put back.' }
          yield* Effect.logWarning(`jellyware: run ${run.id} was interrupted while installing; put back`)
        } else if (run.state === 'queued' || run.state === 'working' || run.state === 'checking') {
          run = { ...run, state: 'failed', error: 'Interrupted: the app stopped during the run.' }
        } else if (run.state === 'review' && (yield* Effect.promise(() => hashFolder(join(directoryOf(id), 'snapshot')))) === null) {
          run = { ...run, state: 'failed', error: 'The snapshot to review is gone.' }
        }
        yield* save(run)
      }

      /** What differs between the live folder and the snapshot, for the
       *  extensions in either. */
      const diff = (snapshot: string, baseline: Hashes) =>
        Effect.gen(function* () {
          const ids = new Set([...baseline.keys(), ...(yield* Effect.promise(() => listFolders(snapshot)))])
          const after = yield* hashesOf(snapshot, ids)
          const changes: Array<ChangedExtension> = []
          for (const id of [...ids].sort()) {
            const before = baseline.get(id) ?? null
            const now = after.get(id) ?? null
            if (before === now) continue
            changes.push({ id, action: before === null ? 'added' : now === null ? 'removed' : 'changed', before, after: now })
          }
          return changes
        })

      /** Checks the snapshot; fails with what the agent should fix. */
      const check = (snapshot: string, runDirectory: string, changes: ReadonlyArray<ChangedExtension>) =>
        Effect.gen(function* () {
          const present = changes.filter(change => change.action !== 'removed').map(change => change.id)
          for (const id of present) {
            yield* checkManifest(snapshot, id)
            yield* scanForSecrets(snapshot, id)
          }
          for (const each of options.checks) {
            yield* each
              .run({ snapshot, runDirectory, changed: present })
              .pipe(Effect.mapError(message => `${each.name} failed:\n${message}`))
          }
        })

      /** Copies the live folders of `changes` to the run's `before/`; fails
       *  when one changed since the run started. */
      const keepBefore = (run: Run, baseline: Hashes, changes: ReadonlyArray<ChangedExtension>) =>
        Effect.gen(function* () {
          const ids = changes.map(change => change.id)
          const now = yield* hashesOf(live, ids)
          const moved = ids.filter(id => (now.get(id) ?? null) !== (baseline.get(id) ?? null))
          if (moved.length > 0) {
            return yield* Effect.fail({
              retry: false,
              message: `Refused: ${moved.join(', ')} changed since this run started. Run the prompt again.`,
            })
          }
          const runDirectory = directoryOf(run.id)
          yield* Effect.promise(() => rm(join(runDirectory, 'before'), { recursive: true, force: true }))
          for (const id of ids) {
            yield* Effect.promise(() => copyFolder(join(live, id), join(runDirectory, 'before', id)))
          }
        })

      /** Installs the snapshot's changes; fails with the build error when an
       *  extension does not build (after putting everything back). */
      const install = (run: Run, snapshot: string, baseline: Hashes, changes: ReadonlyArray<ChangedExtension>) =>
        Effect.gen(function* () {
          const ids = changes.map(change => change.id)
          yield* keepBefore(run, baseline, changes)
          yield* save({ ...run, state: 'installing', changes })
          for (const id of ids) {
            yield* Effect.promise(() => mirrorFolder(join(snapshot, id), join(live, id)))
          }
          yield* reloadAll(ids)
          const statuses = yield* extensions.current
          const broken = statuses.filter(status => ids.includes(status.id) && status.state === 'failed')
          if (broken.length > 0) {
            yield* restore(run, changes)
            return yield* Effect.fail({
              retry: true,
              message: broken.map(status => `${status.id} failed to load:\n${status.error ?? ''}`).join('\n\n'),
            })
          }
        })

      const execute = (queued: Run) =>
        Effect.gen(function* () {
          const runDirectory = directoryOf(queued.id)
          const stage = join(runDirectory, 'stage')
          const snapshot = join(runDirectory, 'snapshot')
          let run: Run = { ...queued, state: 'working' }
          yield* save(run)

          const baseline = yield* hashesOf(live, yield* Effect.promise(() => listFolders(live)))
          yield* Effect.promise(() => copyFolder(live, stage))
          const guarded = yield* hashTree(protectedDirectories)

          let feedback: string | null = null
          while (true) {
            run = { ...run, state: 'working', attempts: run.attempts + 1 }
            yield* save(run)
            const summary = yield* options.agent.work({ prompt: run.prompt, stage, runDirectory, feedback })
            run = { ...run, summary, state: 'checking' }
            yield* save(run)

            if ((yield* hashTree(protectedDirectories)) !== guarded) {
              return yield* save({
                ...run,
                state: 'failed',
                error: 'The agent changed files outside the extensions. Nothing was installed; check the app sources.',
              })
            }

            yield* Effect.promise(() => rm(snapshot, { recursive: true, force: true }))
            yield* Effect.promise(() => copyFolder(stage, snapshot))
            const changes = yield* diff(snapshot, baseline)
            if (changes.length === 0) return yield* save({ ...run, state: 'unchanged', changes })

            if (options.review === true) {
              const refused = yield* check(snapshot, runDirectory, changes).pipe(
                Effect.mapError(message => ({ retry: true, message })),
                Effect.flatMap(() => installLock.withPermits(1)(keepBefore(run, baseline, changes))),
                Effect.as(null),
                Effect.catch(error => Effect.succeed(error)),
              )
              if (refused === null) return yield* save({ ...run, state: 'review', changes })
              if (!refused.retry || run.attempts >= maxAttempts) {
                return yield* save({ ...run, state: 'failed', changes, error: refused.message })
              }
              feedback = refused.message
              continue
            }

            const problem: { retry: boolean; message: string } | null = yield* check(snapshot, runDirectory, changes).pipe(
              Effect.flatMap(() => installLock.withPermits(1)(install(run, snapshot, baseline, changes))),
              Effect.as(null),
              Effect.catch(error => Effect.succeed(typeof error === 'string' ? { retry: true, message: error } : error)),
            )
            if (problem === null) {
              return yield* save({ ...run, state: 'installed', changes })
            }
            if (!problem.retry || run.attempts >= maxAttempts) {
              return yield* save({ ...run, state: 'failed', changes, error: problem.message })
            }
            feedback = problem.message
          }
        }).pipe(
          Effect.catchTag('AgentError', error =>
            Effect.flatMap(SubscriptionRef.get(runs), list => {
              const latest = list.find(other => other.id === queued.id) ?? queued
              return save({ ...latest, state: 'failed', error: `The agent failed: ${error.message}` })
            }),
          ),
          Effect.withSpan('jellyware.run', { attributes: { run: queued.id } }),
        )

      const inReview = (runId: string) =>
        Effect.gen(function* () {
          const run = (yield* SubscriptionRef.get(runs)).find(other => other.id === runId)
          if (run === undefined) return yield* new ReviewRefused({ message: `No run ${runId}.` })
          if (run.state !== 'review') {
            return yield* new ReviewRefused({ message: `Only a run waiting for review can be approved or rejected; this one is ${run.state}.` })
          }
          return run
        })

      // One run at a time, in the order they were started.
      const queue = yield* Queue.unbounded<Run>()
      yield* Queue.take(queue).pipe(Effect.flatMap(execute), Effect.forever, Effect.forkScoped)

      return Changes.of({
        changes: SubscriptionRef.changes(runs),
        current: SubscriptionRef.get(runs),
        start: (prompt, author) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const id = `${new Date(now).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`
            yield* Effect.promise(() => mkdir(directoryOf(id), { recursive: true }))
            const run: Run = {
              id,
              prompt,
              author,
              startedAt: now,
              finishedAt: null,
              state: 'queued',
              attempts: 0,
              changes: [],
              summary: null,
              error: null,
              reviewer: null,
            }
            yield* save(run)
            yield* Queue.offer(queue, run)
            return id
          }),
        undo: runId =>
          installLock.withPermits(1)(
            Effect.gen(function* () {
              const run = (yield* SubscriptionRef.get(runs)).find(other => other.id === runId)
              if (run === undefined) return yield* new UndoRefused({ message: `No run ${runId}.` })
              if (run.state !== 'installed') {
                return yield* new UndoRefused({ message: `Only an installed run can be undone; this one is ${run.state}.` })
              }
              const now = yield* hashesOf(live, run.changes.map(change => change.id))
              const newer = run.changes.filter(change => (now.get(change.id) ?? null) !== change.after)
              if (newer.length > 0) {
                return yield* new UndoRefused({
                  message: `${newer.map(change => change.id).join(', ')} changed since this run. Undo the newer runs first.`,
                })
              }
              yield* restore(run, run.changes)
              yield* save({ ...run, state: 'undone' })
            }),
          ),
        approve: (runId, reviewer) =>
          installLock.withPermits(1)(
            Effect.gen(function* () {
              const run = yield* inReview(runId)
              const baseline: Hashes = new Map(run.changes.map(change => [change.id, change.before]))
              const reviewed: Run = { ...run, reviewer }
              const problem = yield* install(reviewed, join(directoryOf(run.id), 'snapshot'), baseline, run.changes).pipe(
                Effect.as(null),
                Effect.catch(error => Effect.succeed(error.message)),
              )
              yield* save(problem === null ? { ...reviewed, state: 'installed' } : { ...reviewed, state: 'failed', error: problem })
            }),
          ),
        reject: (runId, reviewer) =>
          installLock.withPermits(1)(
            Effect.gen(function* () {
              const run = yield* inReview(runId)
              yield* save({ ...run, state: 'rejected', reviewer })
            }),
          ),
        diff: runId =>
          Effect.gen(function* () {
            const run = (yield* SubscriptionRef.get(runs)).find(other => other.id === runId)
            if (run === undefined) return yield* new ReviewRefused({ message: `No run ${runId}.` })
            const before = join(directoryOf(run.id), 'before')
            if (run.changes.length === 0 || (yield* Effect.promise(() => stat(before).then(() => true, () => false))) === false) {
              return yield* new ReviewRefused({ message: 'This run has no changes to show.' })
            }
            return yield* Effect.promise(() =>
              diffFolders(before, join(directoryOf(run.id), 'snapshot'), run.changes.map(change => change.id)),
            )
          }),
      })
    }),
  )
