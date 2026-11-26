import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { Clock, Context, Data, Effect, Layer, Queue, Schema as S, Semaphore, Stream, SubscriptionRef } from 'effect'

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
   3. Check: with `declaredChanges`, the agent's answer ends with a line
      `Changed: <ids>` that must name exactly the extensions whose folders
      differ (after Powermove); a mismatch goes back to the agent before
      anything else is checked. Then manifests, a scan for credentials, and
      the app's checks (its typecheck, the extensions' tests). A failure goes
      back to the agent, a limited number of times.
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

   Each run keeps its activity (`activity`): what the agent reports while it
   works (what it says, the tools it calls) and each step above, as it
   happens. A run started with `thread` follows up a conversation: the
   agent gets the newest run before it (`Task.previous`) to carry on from.

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
  /** The first run of the conversation this run follows up; null for the
   *  first run of one. */
  thread: S.NullOr(S.String).pipe(S.withDecodingDefaultKey(Effect.succeed(null))),
  /** What the app passed to `start` for the agent (which agent, which
   *  model); a follow-up without its own keeps the run's before it. */
  options: S.NullOr(S.Json).pipe(S.withDecodingDefaultKey(Effect.succeed(null))),
  /** What a reviewer should know besides the diff, such as files outside
   *  the extensions that changed while the agent worked. */
  warnings: S.Array(S.String).pipe(S.withDecodingDefaultKey(Effect.succeed([]))),
})
export type Run = typeof Run.Type

/** The conversation a run belongs to: the id of its first run. */
export const threadOf = (run: Run): string => run.thread ?? run.id

export const ActivityState = S.Literals(['running', 'done', 'failed', 'info'])
export type ActivityState = typeof ActivityState.Type

/** One entry of what happened in a run, in order: what the agent said, a
 *  tool it called, or a step of the pipeline (an attempt, a check, the
 *  review, the install). A tool or a step reported again with its id
 *  replaces the earlier entry, keeping its start (`at`); `until` is when it
 *  ended. */
export const Activity = S.Union([
  S.TaggedStruct('Said', { at: S.Number, text: S.String }),
  S.TaggedStruct('Tool', {
    id: S.String,
    at: S.Number,
    until: S.NullOr(S.Number),
    name: S.String,
    /** What it worked on: a path, a pattern. */
    target: S.String,
    state: ActivityState,
    /** The error, when it failed. */
    detail: S.NullOr(S.String),
  }),
  S.TaggedStruct('Step', {
    id: S.String,
    at: S.Number,
    until: S.NullOr(S.Number),
    text: S.String,
    state: ActivityState,
    detail: S.NullOr(S.String),
  }),
])
export type Activity = typeof Activity.Type

/** What an agent reports while it works; the pipeline adds the times. */
export type AgentEvent =
  | Readonly<{ _tag: 'Said'; text: string }>
  | Readonly<{ _tag: 'Tool'; id: string; name: string; target: string; state: 'running' | 'done' | 'failed'; detail: string | null }>

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
  /** What the app has now (`Options.guide`), made when the run started;
   *  null without one. */
  guide: string | null
  /** The run this one follows up (the newest before it in its
   *  conversation), so the agent can carry on from it; null for the first
   *  run of a conversation. Its changes are live only when it is
   *  `installed`. */
  previous: Readonly<{ runDirectory: string; prompt: string; state: RunState; summary: string | null }> | null
  /** Reports progress (what it says, the tools it calls) to the run's
   *  activity. */
  report: (event: AgentEvent) => Effect.Effect<void>
  /** The run's options from `start` (or its conversation's); null without. */
  options: S.Json | null
  /** Whether the app restarted while the agent worked on this run: the
   *  stage still has what it did so far. */
  resumed: boolean
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

/** A follow-up to a conversation that does not exist or still works. */
export class StartRefused extends Data.TaggedError('StartRefused')<{ readonly message: string }> {}

export class Changes extends Context.Service<
  Changes,
  {
    /** The runs, newest first, now and after every change. */
    readonly changes: Stream.Stream<ReadonlyArray<Run>>
    readonly current: Effect.Effect<ReadonlyArray<Run>>
    /** Queues a run; up to `concurrency` work at a time. Answers with its
     *  id. With `thread` (a run id), it follows up that run's conversation:
     *  the agent carries on from the newest run in it, which must be over. */
    readonly start: (prompt: string, author: string, thread?: string, options?: S.Json) => Effect.Effect<string, StartRefused>
    /** What happened in a run so far, now and after every change. */
    readonly activity: (runId: string) => Stream.Stream<ReadonlyArray<Activity>>
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

export type Options<R = never> = Readonly<{
  /** The live extensions folder the loader watches. */
  extensionsDirectory: string
  /** Where runs keep their stages, snapshots and journals. */
  workDirectory: string
  agent: Agent
  checks: ReadonlyArray<Check>
  /** Folders the agent must not change (the app's own sources). Files in
   *  them that change while the agent works fail the run; with `review`,
   *  the run goes on to review with a warning that names them instead (a
   *  person may have changed them meanwhile, and the reviewer can tell). */
  protectedDirectories?: ReadonlyArray<string>
  /** Whether runs the app stopped during (queued, working or checking) carry
   *  on when it starts again, from the stage they left. Default true; false
   *  fails them. */
  resume?: boolean
  /** How often the agent may work on one run, retries included. Default 3. */
  attempts?: number
  /** How many runs may work at a time; more wait in `queued`. Default 1.
   *  The agent and the checks must then cope with several runs at once. */
  concurrency?: number
  /** Whether a checked run waits for a person to approve it. Default
   *  false: it installs at once. */
  review?: boolean
  /** Describes the app for the agent (`guide` in guide.ts); run when a run
   *  starts. */
  guide?: Effect.Effect<string, never, R>
  /** Whether the agent's answer must end with `Changed: <ids>` (or
   *  `Changed: none`) naming exactly the extensions it created, changed or
   *  removed. The line is not kept in the run's summary. Default false. */
  declaredChanges?: boolean
}>

const CHANGED_LINE = /^\s*changed:\s*(.*?)\s*\.?\s*$/i

/** The extensions an answer's last `Changed:` line names, and the answer
 *  without it; `declared` is null when there is no such line. */
export const parseDeclared = (answer: string): Readonly<{ declared: ReadonlyArray<string> | null; summary: string }> => {
  const lines = answer.trimEnd().split(/\r?\n/)
  let index = lines.length - 1
  while (index >= 0 && !CHANGED_LINE.test(lines[index] ?? '')) index--
  if (index === -1) return { declared: null, summary: answer.trim() }
  const list = CHANGED_LINE.exec(lines[index] ?? '')?.[1] ?? ''
  const declared =
    list.toLowerCase() === 'none' || list === ''
      ? []
      : [...new Set(list.split(/[,\s]+/).map(id => id.replace(/^[`'"]+|[`'"/]+$/g, '')).filter(id => id !== ''))].sort()
  return { declared, summary: lines.filter((_, at) => at !== index).join('\n').trim() }
}

/** What to tell the agent when its `Changed:` line does not fit the
 *  folders; null when it fits. */
export const declaredMismatch = (declared: ReadonlyArray<string> | null, actual: ReadonlyArray<string>): string | null => {
  const list = (ids: ReadonlyArray<string>) => (ids.length === 0 ? 'none' : ids.join(', '))
  if (declared === null) {
    return `End your answer with a line \`Changed: <ids>\` naming the extensions you created, changed or removed (\`Changed: none\` if none). The files show changes in: ${list(actual)}.`
  }
  const sorted = [...actual].sort()
  if (declared.length === sorted.length && declared.every((id, at) => id === sorted[at])) return null
  const missing = sorted.filter(id => !declared.includes(id))
  const extra = declared.filter(id => !sorted.includes(id))
  return [
    `You said you changed ${list(declared)}, but the files show changes in ${list(sorted)}.`,
    ...(missing.length === 0 ? [] : [`Changed but not named: ${missing.join(', ')}. If you did not mean to change them, put them back as they were.`]),
    ...(extra.length === 0 ? [] : [`Named but unchanged: ${extra.join(', ')}. If you meant to change them, do it now.`]),
    'Then answer again, ending with the corrected `Changed:` line.',
  ].join('\n')
}

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

/** Every file under the directories with a hash of its content, by path. */
const hashTree = (directories: ReadonlyArray<string>) =>
  Effect.promise(async () => {
    const hashes = new Map<string, string>()
    for (const directory of directories) {
      for (const file of await listFiles(directory)) {
        const content = await readFile(join(directory, file)).catch(() => null)
        if (content !== null) hashes.set(join(directory, file), createHash('sha256').update(content).digest('hex'))
      }
    }
    return hashes
  })

/** The paths whose content differs between two `hashTree`s, shortened to
 *  start at the protected folder's name. */
const changedFiles = (before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>, directories: ReadonlyArray<string>) => {
  const paths = new Set([...before.keys(), ...after.keys()])
  const short = (path: string) => {
    const root = directories.find(directory => path.startsWith(directory))
    return root === undefined ? path : relative(dirname(root), path).split(sep).join('/')
  }
  return [...paths].filter(path => before.get(path) !== after.get(path)).map(short).sort()
}

const encodeRun = S.encodeEffect(S.fromJsonString(Run))
const decodeRun = S.decodeUnknownEffect(S.fromJsonString(Run))
const encodeActivity = S.encodeEffect(S.fromJsonString(S.Array(Activity)))
const decodeActivity = S.decodeUnknownEffect(S.fromJsonString(S.Array(Activity)))

/** The entries a run keeps; the oldest go first. */
const MAX_ACTIVITY = 600

/** Runs that are not over yet. */
const BUSY: ReadonlySet<RunState> = new Set(['queued', 'working', 'checking'])

/** The change pipeline for the extensions the loader (`Extensions`) runs. */
export const layer = <R = never>(options: Options<R>): Layer.Layer<Changes, never, Extensions | R> =>
  Layer.effect(
    Changes,
    Effect.gen(function* () {
      const extensions = yield* Extensions
      const appServices = yield* Effect.context<R>()
      /** The guide now; a guide that dies leaves the agent without one. */
      const describeApp =
        options.guide === undefined
          ? Effect.succeed(null)
          : options.guide.pipe(
              Effect.provideContext(appServices),
              Effect.catchCause(cause => Effect.as(Effect.logWarning('jellyware: the guide failed', cause), null)),
            )
      const live = resolve(options.extensionsDirectory)
      const work = resolve(options.workDirectory)
      const runsDirectory = join(work, 'runs')
      const maxAttempts = options.attempts ?? 3
      // Checks resolve the app's modules from a run's snapshot: outside the
      // app's folder, package imports (`#app/...`) and types are not found.
      if (relative(dirname(live), work).startsWith('..')) {
        yield* Effect.logWarning(`jellyware: runs live outside the app's folder (${work}); typechecks and tests of a run may not find the app's modules`)
      }
      const protectedDirectories = (options.protectedDirectories ?? []).map(directory => resolve(directory))
      yield* Effect.promise(() => mkdir(runsDirectory, { recursive: true }))

      const runs = yield* SubscriptionRef.make<ReadonlyArray<Run>>([])
      const installLock = yield* Semaphore.make(1)
      const directoryOf = (id: string) => join(runsDirectory, id)

      // ACTIVITY: per run in memory once read, kept in `activity.json`.
      const activities = new Map<string, SubscriptionRef.SubscriptionRef<ReadonlyArray<Activity>>>()
      const activityLock = yield* Semaphore.make(1)
      const activityOf = (runId: string) =>
        Effect.gen(function* () {
          const known = activities.get(runId)
          if (known !== undefined) return known
          const text = yield* Effect.promise(() => readFile(join(directoryOf(runId), 'activity.json'), 'utf8').catch(() => null))
          const list = text === null ? [] : yield* decodeActivity(text).pipe(Effect.orElseSucceed((): ReadonlyArray<Activity> => []))
          const again = activities.get(runId)
          if (again !== undefined) return again
          const ref = yield* SubscriptionRef.make<ReadonlyArray<Activity>>(list)
          activities.set(runId, ref)
          return ref
        })
      /** Adds an entry to a run's activity, or replaces the tool or step
       *  with its id (keeping when it started). */
      const note = (runId: string, entry: Activity) =>
        activityLock.withPermits(1)(
          Effect.gen(function* () {
            const ref = yield* activityOf(runId)
            const list = yield* SubscriptionRef.get(ref)
            const at = entry._tag === 'Said' ? -1 : list.findIndex(other => other._tag === entry._tag && 'id' in other && other.id === entry.id)
            const next =
              at === -1
                ? [...list, entry].slice(-MAX_ACTIVITY)
                : list.map((other, index) => (index === at ? { ...entry, at: other.at } : other))
            yield* SubscriptionRef.set(ref, next)
            const json = yield* encodeActivity(next).pipe(Effect.orDie)
            yield* Effect.promise(() => writeFile(join(directoryOf(runId), 'activity.json'), json).catch(() => undefined))
          }),
        )
      /** A step of the pipeline: `running` until reported again as done or
       *  failed; `info` is a note. */
      const step = (runId: string, id: string, text: string, state: ActivityState, detail: string | null = null) =>
        Effect.flatMap(Clock.currentTimeMillis, now =>
          note(runId, { _tag: 'Step', id, at: now, until: state === 'running' || state === 'info' ? null : now, text, state, detail }),
        )
      /** Reports an agent's event in a run's activity. */
      const reportTo = (runId: string, attempt: number) => (event: AgentEvent) =>
        Effect.flatMap(Clock.currentTimeMillis, now =>
          note(
            runId,
            event._tag === 'Said'
              ? { _tag: 'Said', at: now, text: event.text }
              : { ...event, id: `tool-${attempt}-${event.id}`, at: now, until: event.state === 'running' ? null : now },
          ),
        )

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

      // Runs interrupted while installing: put back what they changed. Runs
      // interrupted while the agent worked carry on (`resume`).
      const resumable: Array<Run> = []
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
          if (options.resume !== false) {
            // It carries on once the queue runs, from the stage it left.
            resumable.push(run)
            continue
          }
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

      /** Checks the snapshot; fails with what the agent should fix. Each
       *  check is a step of the run's activity. */
      const check = (run: Run, snapshot: string, runDirectory: string, changes: ReadonlyArray<ChangedExtension>) =>
        Effect.gen(function* () {
          const present = changes.filter(change => change.action !== 'removed').map(change => change.id)
          const checked = (index: number, name: string, effect: Effect.Effect<void, string>) =>
            Effect.gen(function* () {
              const id = `check-${run.attempts}-${index}`
              yield* step(run.id, id, name, 'running')
              yield* effect.pipe(Effect.tapError(message => step(run.id, id, name, 'failed', message)))
              yield* step(run.id, id, name, 'done')
            })
          yield* checked(
            0,
            'Manifests and credentials',
            Effect.forEach(present, id => Effect.andThen(checkManifest(snapshot, id), scanForSecrets(snapshot, id)), { discard: true }),
          )
          for (const [index, each] of options.checks.entries()) {
            yield* checked(
              index + 1,
              each.name,
              each.run({ snapshot, runDirectory, changed: present }).pipe(Effect.mapError(message => `${each.name} failed:\n${message}`)),
            )
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
          // Made even when every change adds an extension: it marks a run
          // whose changes can be shown.
          yield* Effect.promise(() => mkdir(join(runDirectory, 'before'), { recursive: true }))
          for (const id of ids) {
            yield* Effect.promise(() => copyFolder(join(live, id), join(runDirectory, 'before', id)))
          }
        })

      /** Installs the snapshot's changes; fails with the build error when an
       *  extension does not build (after putting everything back). */
      const install = (run: Run, snapshot: string, baseline: Hashes, changes: ReadonlyArray<ChangedExtension>) =>
        Effect.gen(function* () {
          const ids = changes.map(change => change.id)
          const stepId = `install-${yield* Clock.currentTimeMillis}`
          const installing = `Installing ${ids.join(', ')}`
          yield* keepBefore(run, baseline, changes).pipe(Effect.tapError(error => step(run.id, stepId, installing, 'failed', error.message)))
          yield* step(run.id, stepId, installing, 'running')
          yield* save({ ...run, state: 'installing', changes })
          for (const id of ids) {
            yield* Effect.promise(() => mirrorFolder(join(snapshot, id), join(live, id)))
          }
          yield* reloadAll(ids)
          const statuses = yield* extensions.current
          const broken = statuses.filter(status => ids.includes(status.id) && status.state === 'failed')
          if (broken.length > 0) {
            yield* restore(run, changes)
            const message = broken.map(status => `${status.id} failed to load:\n${status.error ?? ''}`).join('\n\n')
            yield* step(run.id, stepId, `${installing}: it did not load, so it was put back`, 'failed', message)
            return yield* Effect.fail({ retry: true, message })
          }
          yield* step(run.id, stepId, `Installed ${ids.join(', ')}: live now`, 'done')
        })

      const execute = (queued: Run, resumed = false) =>
        Effect.gen(function* () {
          const runDirectory = directoryOf(queued.id)
          const stage = join(runDirectory, 'stage')
          const snapshot = join(runDirectory, 'snapshot')
          let run: Run = { ...queued, state: 'working' }
          yield* save(run)

          const guide = yield* describeApp
          const baseline = yield* hashesOf(live, yield* Effect.promise(() => listFolders(live)))
          // A run that carries on keeps the stage it left.
          const keepStage = resumed && (yield* Effect.promise(() => stat(stage).then(() => true, () => false)))
          if (keepStage) yield* step(run.id, `resumed-${run.attempts}`, 'The app restarted while the agent worked; it carries on', 'info')
          else yield* Effect.promise(() => copyFolder(live, stage))
          const guarded = yield* hashTree(protectedDirectories)
          // The newest run before this one in its conversation.
          const earlier = (yield* SubscriptionRef.get(runs)).find(
            other => other.id !== run.id && threadOf(other) === threadOf(run) && other.startedAt <= run.startedAt,
          )
          const previous =
            earlier === undefined
              ? null
              : { runDirectory: directoryOf(earlier.id), prompt: earlier.prompt, state: earlier.state, summary: earlier.summary }
          /** Sends a failure back to the agent: a note in the activity. */
          const sendBack = (message: string) =>
            step(run.id, `retry-${run.attempts}`, `Sent back to the agent to fix (attempt ${run.attempts + 1} of ${maxAttempts})`, 'info').pipe(
              Effect.as(message),
            )
          /** Whether a failed step already shows the error. */
          const shown = (error: string | null) =>
            Effect.gen(function* () {
              const entries = yield* SubscriptionRef.get(yield* activityOf(run.id))
              return entries.some(entry => entry._tag !== 'Said' && entry.state === 'failed' && entry.detail !== null && (error ?? '').includes(entry.detail))
            })
          const end = (next: Run) =>
            Effect.andThen(
              next.state === 'failed'
                ? Effect.flatMap(shown(next.error), known => step(run.id, 'end', 'Failed: nothing went live', 'failed', known ? null : next.error))
                : next.state === 'unchanged'
                  ? step(run.id, 'end', 'No extension changed', 'info')
                  : next.state === 'review'
                    ? step(run.id, 'end', 'Checks passed. Waiting for review: nothing is live yet', 'info')
                    : Effect.void,
              save(next),
            )

          let feedback: string | null = keepStage
            ? 'The app restarted while you worked on this. The current directory has what you did so far: check it, finish the change, and answer as before.'
            : null
          while (true) {
            run = { ...run, state: 'working', attempts: run.attempts + 1 }
            yield* save(run)
            const working = `agent-${run.attempts}`
            const workingText = run.attempts === 1 ? 'The agent works on the change' : `The agent works on what failed (attempt ${run.attempts})`
            yield* step(run.id, working, workingText, 'running')
            const answer: string = yield* options.agent
              .work({ prompt: run.prompt, stage, runDirectory, feedback, guide, previous, report: reportTo(run.id, run.attempts), options: run.options, resumed: keepStage })
              .pipe(Effect.tapError(error => step(run.id, working, workingText, 'failed', error.message)))
            yield* step(run.id, working, workingText, 'done')
            const { declared, summary } = options.declaredChanges === true ? parseDeclared(answer) : { declared: null, summary: answer }
            run = { ...run, summary, state: 'checking' }
            yield* save(run)

            const outside = changedFiles(guarded, yield* hashTree(protectedDirectories), protectedDirectories)
            if (outside.length > 0) {
              const list = outside.slice(0, 30).map(path => `- ${path}`).join('\n')
              if (options.review !== true) {
                return yield* end({
                  ...run,
                  state: 'failed',
                  error: `Files outside the extensions changed while the agent worked. Nothing was installed; check them:\n${list}`,
                })
              }
              // Someone may have changed them meanwhile: the reviewer decides.
              const warning = `Files outside the extensions changed while the agent worked (by the agent, or by someone else meanwhile); nothing of them is undone:\n${list}`
              if (!run.warnings.includes(warning)) {
                run = { ...run, warnings: [...run.warnings, warning] }
                yield* step(run.id, `outside-${run.attempts}`, 'Files outside the extensions changed while the agent worked', 'failed', list)
              }
            }

            yield* Effect.promise(() => rm(snapshot, { recursive: true, force: true }))
            yield* Effect.promise(() => copyFolder(stage, snapshot))
            const changes = yield* diff(snapshot, baseline)
            // Before anything else: does the agent know what it changed?
            const mismatch: string | null =
              options.declaredChanges === true ? declaredMismatch(declared, changes.map(change => change.id)) : null
            if (mismatch !== null) {
              yield* step(run.id, `declared-${run.attempts}`, 'The extensions the agent named differ from the files it changed', 'failed', mismatch)
              if (run.attempts >= maxAttempts) {
                return yield* end({ ...run, state: 'failed', changes, error: `The agent's account of its changes did not match:\n${mismatch}` })
              }
              feedback = yield* sendBack(mismatch)
              continue
            }
            if (changes.length === 0) return yield* end({ ...run, state: 'unchanged', changes })

            if (options.review === true) {
              const refused = yield* check(run, snapshot, runDirectory, changes).pipe(
                Effect.mapError(message => ({ retry: true, message })),
                Effect.flatMap(() => installLock.withPermits(1)(keepBefore(run, baseline, changes))),
                Effect.as(null),
                Effect.catch(error => Effect.succeed(error)),
              )
              if (refused === null) return yield* end({ ...run, state: 'review', changes })
              if (!refused.retry || run.attempts >= maxAttempts) {
                return yield* end({ ...run, state: 'failed', changes, error: refused.message })
              }
              feedback = yield* sendBack(refused.message)
              continue
            }

            const problem: { retry: boolean; message: string } | null = yield* check(run, snapshot, runDirectory, changes).pipe(
              Effect.flatMap(() => installLock.withPermits(1)(install(run, snapshot, baseline, changes))),
              Effect.as(null),
              Effect.catch(error => Effect.succeed(typeof error === 'string' ? { retry: true, message: error } : error)),
            )
            if (problem === null) {
              return yield* save({ ...run, state: 'installed', changes })
            }
            if (!problem.retry || run.attempts >= maxAttempts) {
              return yield* end({ ...run, state: 'failed', changes, error: problem.message })
            }
            feedback = yield* sendBack(problem.message)
          }
        }).pipe(
          Effect.catchTag('AgentError', error =>
            Effect.flatMap(SubscriptionRef.get(runs), list => {
              const latest = list.find(other => other.id === queued.id) ?? queued
              return Effect.andThen(
                step(queued.id, 'end', 'Failed: the agent stopped', 'failed', error.message),
                save({ ...latest, state: 'failed', error: `The agent failed: ${error.message}` }),
              )
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

      // Up to `concurrency` runs at a time, started in the order they came.
      // Each works on its own stage; installs take turns (installLock), and
      // a run whose extensions changed since it started is refused.
      const queue = yield* Queue.unbounded<Run>()
      const slots = yield* Semaphore.make(Math.max(1, options.concurrency ?? 1))
      const runScope = yield* Effect.scope
      yield* Effect.gen(function* () {
        yield* slots.take(1)
        const next = yield* Queue.take(queue)
        const { resumed, ...run } = next as Run & { resumed?: boolean }
        yield* execute(run, resumed === true).pipe(Effect.ensuring(slots.release(1)), Effect.forkIn(runScope))
      }).pipe(Effect.forever, Effect.forkScoped)
      // Runs the app stopped during carry on, oldest first.
      for (const run of resumable.sort((a, b) => a.startedAt - b.startedAt)) {
        yield* Effect.logInfo(`jellyware: run ${run.id} carries on after a restart`)
        yield* save(run)
        yield* Queue.offer(queue, { ...run, resumed: true } as Run)
      }

      return Changes.of({
        changes: SubscriptionRef.changes(runs),
        current: SubscriptionRef.get(runs),
        start: (prompt, author, thread, runOptions) =>
          Effect.gen(function* () {
            // A follow-up joins the conversation of the run it names, once
            // the newest run there is over.
            let root: string | null = null
            let inherited: S.Json | null = null
            if (thread !== undefined) {
              const list = yield* SubscriptionRef.get(runs)
              const named = list.find(other => other.id === thread)
              if (named === undefined) return yield* new StartRefused({ message: `No run ${thread}.` })
              root = threadOf(named)
              const newest = list.find(other => threadOf(other) === root)
              if (newest !== undefined && BUSY.has(newest.state)) {
                return yield* new StartRefused({ message: 'The agent is still working on this conversation. Wait until it is done.' })
              }
              inherited = newest?.options ?? null
            }
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
              thread: root,
              options: runOptions ?? inherited,
              warnings: [],
            }
            yield* save(run)
            yield* Queue.offer(queue, run)
            return id
          }),
        activity: runId =>
          Stream.unwrap(
            Effect.gen(function* () {
              const known = (yield* SubscriptionRef.get(runs)).some(other => other.id === runId)
              if (!known) return Stream.succeed<ReadonlyArray<Activity>>([])
              return SubscriptionRef.changes(yield* activityOf(runId))
            }),
          ),
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
              yield* step(run.id, `undo-${yield* Clock.currentTimeMillis}`, 'Undone: the extensions are as they were before', 'info')
              yield* save({ ...run, state: 'undone' })
            }),
          ),
        approve: (runId, reviewer) =>
          installLock.withPermits(1)(
            Effect.gen(function* () {
              const run = yield* inReview(runId)
              const baseline: Hashes = new Map(run.changes.map(change => [change.id, change.before]))
              const reviewed: Run = { ...run, reviewer }
              yield* step(run.id, 'review', `Approved by ${reviewer}`, 'done')
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
              yield* step(run.id, 'review', `Rejected by ${reviewer}: nothing went live`, 'info')
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
