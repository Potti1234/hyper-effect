import { execFileSync, spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Cause, Effect, Option, Queue, Schema as S, Semaphore, Stream } from 'effect'

import { type Agent, AgentError, type AgentEvent, type Check, type RunState, type Task, isTestFile } from '@hyper-effect/jellyware'

import type { Guard } from '../pi-guard.ts'
import { importRules } from './extension-rules.ts'
import { remoteServices } from './remote.ts'

/* The agent that changes this app's extensions, and the checks its work
   must pass besides the import rules: the typecheck, and the extensions' own
   tests.

   The agent is pi (https://github.com/badlogic/pi-mono), run once per
   attempt in JSON mode, in the run's stage folder, with file tools only
   (read, edit, write, grep, find, ls; no shell). Its events (what it says,
   each tool call and its outcome) go to the run's activity as they come; its
   last message is the answer. A retry continues the same pi session with
   what failed; a follow-up in a conversation forks the session of the run
   before it, told what became of that run. Its system prompt gets the rules below and
   the app's guide: the pages, slots, commands, sidebar entries and
   extensions running now (`guide` in @hyper-effect/jellyware). The pi extension in src/pi-guard.ts limits
   those tools: writes only in the stage, reads in the stage and the
   repository but not in `.jellyware`, `.git`, session snapshots or `.env`
   files.

   Credentials: pi and the Codex CLI sign in to the same ChatGPT account, and
   refreshing an OAuth token rotates it, so whichever refreshes invalidates
   the other's copy. pi therefore never refreshes here. Before each attempt
   the current access token from the Codex CLI's `auth.json` (which the
   Codex CLI keeps fresh) is written to this app's own pi folder
   (`.jellyware/pi-agent`), without a refresh token, and deleted when pi
   stops; one left by a server that stopped during an attempt is deleted
   when the agent is made. An attempt starts only while the token has an
   hour left; running `codex` refreshes it.

   Environment: JELLYWARE_MODEL (default gpt-6.1-sol), JELLYWARE_THINKING
   (default medium), JELLYWARE_PI_CLI (pi's cli.js; default: found through
   `npm root -g`), CODEX_HOME (default ~/.codex). */

const CodexAuth = S.Struct({
  tokens: S.Struct({ access_token: S.String, account_id: S.String }),
})
const decodeCodexAuth = S.decodeUnknownEffect(S.fromJsonString(CodexAuth))
const JwtPayload = S.Struct({ exp: S.Number })
const decodeJwtPayload = S.decodeUnknownEffect(S.fromJsonString(JwtPayload))

const fail = (message: string) => new AgentError({ message })

const credentialsFile = (agentDirectory: string) => join(agentDirectory, 'auth.json')

/** Writes pi's credentials from the Codex CLI's login. */
const writeCredentials = (agentDirectory: string) =>
  Effect.gen(function* () {
    const codexHome = process.env['CODEX_HOME'] ?? join(homedir(), '.codex')
    const text = yield* Effect.tryPromise({
      try: () => readFile(join(codexHome, 'auth.json'), 'utf8'),
      catch: () => fail(`No Codex login in ${codexHome}: sign in with \`codex login\`.`),
    })
    const auth = yield* decodeCodexAuth(text).pipe(
      Effect.mapError(() => fail('The Codex login is not a ChatGPT login: sign in with `codex login`.')),
    )
    const payload = Buffer.from(auth.tokens.access_token.split('.')[1] ?? '', 'base64url').toString('utf8')
    const { exp } = yield* decodeJwtPayload(payload).pipe(Effect.mapError(() => fail('The Codex access token is not readable.')))
    const expires = exp * 1000
    if (expires - Date.now() < 60 * 60 * 1000) {
      return yield* Effect.fail(fail('The Codex login expires within the hour: run `codex` once to refresh it.'))
    }
    const credentials = {
      'openai-codex': { type: 'oauth', access: auth.tokens.access_token, refresh: '', expires, accountId: auth.tokens.account_id },
    }
    yield* Effect.promise(async () => {
      await mkdir(agentDirectory, { recursive: true })
      await writeFile(credentialsFile(agentDirectory), JSON.stringify(credentials), { mode: 0o600 })
    })
  })

const piCli = (): string => {
  const configured = process.env['JELLYWARE_PI_CLI']
  if (configured !== undefined) return configured
  const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true }).trim()
  return join(root, '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js')
}

/** Runs a Node program without a shell; answers with stdout, fails with the
 *  end of stderr. */
const runNode = (args: ReadonlyArray<string>, options: Readonly<{ cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number }>) =>
  Effect.callback<string, string>(resume => {
    // No stdin: pi in print mode reads piped stdin as more input and would
    // wait for it to end.
    const child = spawn(process.execPath, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += String(chunk)))
    child.stderr.on('data', chunk => (stderr += String(chunk)))
    const timer = setTimeout(() => child.kill(), options.timeoutMs)
    child.on('error', error => resume(Effect.fail(String(error))))
    child.on('close', code => {
      clearTimeout(timer)
      resume(code === 0 ? Effect.succeed(stdout) : Effect.fail(`${(stderr || stdout).slice(-4000)}\n(exit ${code})`))
    })
    return Effect.sync(() => child.kill())
  })

/** Runs a Node program without a shell and hands each line of its stdout
 *  to `onLine` as it comes; fails with the end of stderr. */
const runNodeLines = <E>(
  args: ReadonlyArray<string>,
  options: Readonly<{ cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number }>,
  onLine: (line: string) => Effect.Effect<void, E>,
) =>
  Stream.callback<string, string>(queue =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const child = spawn(process.execPath, [...args], {
          cwd: options.cwd,
          env: options.env ?? process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
        // Records end at LF only (pi's framing); a JSON string may hold
        // other line separators.
        let pending = ''
        let stderr = ''
        const emit = (line: string) => {
          const trimmed = line.replace(/\r$/, '')
          if (trimmed !== '') Queue.offerUnsafe(queue, trimmed)
        }
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          pending += chunk
          let at = pending.indexOf('\n')
          while (at !== -1) {
            emit(pending.slice(0, at))
            pending = pending.slice(at + 1)
            at = pending.indexOf('\n')
          }
        })
        child.stderr.on('data', chunk => (stderr = (stderr + String(chunk)).slice(-8000)))
        const timer = setTimeout(() => child.kill(), options.timeoutMs)
        child.on('error', error => Queue.failCauseUnsafe(queue, Cause.fail(String(error))))
        child.on('close', code => {
          clearTimeout(timer)
          emit(pending)
          if (code === 0) Queue.endUnsafe(queue)
          else Queue.failCauseUnsafe(queue, Cause.fail(`${stderr.slice(-4000)}\n(exit ${code})`))
        })
        return child
      }),
      child => Effect.sync(() => child.kill()),
    ),
  ).pipe(Stream.runForEach(onLine))

// PI'S EVENTS (docs/json.md of pi): the ones the activity shows.

const TextBlock = S.Struct({ type: S.Literal('text'), text: S.String })
const AnyBlock = S.Struct({ type: S.String })
const PiEvent = S.Union([
  S.Struct({ type: S.Literal('tool_execution_start'), toolCallId: S.String, toolName: S.String, args: S.optional(S.Unknown) }),
  S.Struct({
    type: S.Literal('tool_execution_end'),
    toolCallId: S.String,
    toolName: S.String,
    isError: S.Boolean,
    result: S.optional(S.Struct({ content: S.optional(S.Array(S.Union([TextBlock, AnyBlock]))) })),
  }),
  S.Struct({
    type: S.Literal('message_end'),
    message: S.Struct({
      role: S.String,
      content: S.optional(S.Union([S.String, S.Array(S.Union([TextBlock, AnyBlock]))])),
      stopReason: S.optional(S.String),
      errorMessage: S.optional(S.String),
    }),
  }),
])
type PiEvent = typeof PiEvent.Type
const decodePiEvent = S.decodeUnknownOption(S.fromJsonString(PiEvent))
const ToolArgs = S.Struct({ path: S.optional(S.String), pattern: S.optional(S.String) })
const decodeToolArgs = S.decodeUnknownOption(ToolArgs)

const textOf = (content: ReadonlyArray<{ readonly type: string }> | string | undefined): string =>
  typeof content === 'string'
    ? content
    : (content ?? [])
        .map(block => ('text' in block && typeof block.text === 'string' ? block.text : ''))
        .join('')
        .trim()

/** What a tool worked on, short: paths relative to the stage or the
 *  repository. */
const targetOf = (args: unknown, roots: ReadonlyArray<string>): string => {
  const decoded = decodeToolArgs(args)
  if (Option.isNone(decoded)) return ''
  const short = (path: string) => {
    const slashed = path.split('\\').join('/')
    for (const root of roots) {
      const prefix = `${root.split('\\').join('/')}/`
      if (slashed.toLowerCase().startsWith(prefix.toLowerCase())) return slashed.slice(prefix.length)
    }
    return slashed
  }
  const { path, pattern } = decoded.value
  if (pattern !== undefined) return path === undefined ? pattern : `${pattern} in ${short(path)}`
  return path === undefined ? '' : short(path)
}

/** What became of the run a follow-up carries on from, for the agent. */
const OUTCOME: Readonly<Record<RunState, string>> = {
  queued: 'did not run',
  working: 'did not finish',
  checking: 'did not finish',
  review: 'waits for review and is not live',
  installing: 'did not finish installing',
  installed: 'went live',
  unchanged: 'changed nothing',
  failed: 'failed, so nothing of it went live',
  rejected: 'was rejected by a reviewer, so nothing of it went live',
  undone: 'went live and was undone since',
}

/** pi's session file in a run's folder, if it has one. */
const sessionFileOf = (runDirectory: string) =>
  Effect.promise(async () => {
    const folder = join(runDirectory, 'pi')
    const files = await readdir(folder).catch((): Array<string> => [])
    const found = files.filter(file => file.endsWith('.jsonl')).sort().at(-1)
    return found === undefined ? null : join(folder, found)
  })

/** What an extension in its own process may use of the app's services,
 *  as a sentence for the agent (src/app/remote.ts). */
const sharedMembers = () =>
  remoteServices
    .map(service => `\`${service.key.key.replace(/^.*\//, '')}\` (${Object.keys(service.members).join(', ')})`)
    .join('; ')

/** The import rules as a sentence for the agent. */
const allowedImports = () =>
  [
    ...importRules.allow.map(rule =>
      typeof rule === 'string'
        ? `\`${rule.replace(/^=/, '').replace(/\*$/, '...')}\``
        : `from \`${rule.module}\` only ${rule.names.join(', ')}`,
    ),
    'and files in the extension\'s own folder',
  ].join('; ')

const instructions = (appDirectory: string, repository: string) => `
# Changing this app's extensions

You change the extensions of a running hyper-effect app, a clone of Linear's issue tracker. The current directory is a copy of the app's \`extensions/\` folder: each subfolder is one extension. When you finish, the app checks your work and loads it while people use the app.

- Create and edit files only in the current directory; writes anywhere else are refused. You may read the repository, except \`.jellyware\`, \`.git\`, session snapshots and \`.env\` files.
- You have no shell. The app typechecks your extensions after you finish and sends you the errors.
- Read before you write:
  - ${join(appDirectory, 'AGENTS.md')}: the rules for this app and its extensions.
  - ${join(appDirectory, 'src', 'app', 'extensions.ts')}: what an extension may use (\`requires\`), \`pageOptions\`, and the shell for extension pages (\`loadShell\`, \`shellChanges\`, \`frame\`).
  - \`standup/\` in the current directory: the reference extension (a page and a sidebar entry).
  - ${join(repository, '.claude', 'skills', 'hyper-effect', 'SKILL.md')}: how hyper-effect pages work (Model, Message, ClientMessage, regions, Subscriptions).
  - The app's modules under ${join(appDirectory, 'src', 'app')} (domain.ts, store.ts, view/).
- An extension is \`<id>/extension.json\` ({ "id": "<id>", "name", "version", "entry" }) and an entry module whose default export is \`extension(Layer...)\` from \`#app/extensions\`. Import the app as \`#app/...\`.
- To add to the app's own pages instead of a page of its own, use a slot: cards under an issue's properties (\`issueSidebar\`), entries in the issue lists' command palette (\`issuesPalette\`), badges on issue rows and board cards (\`issueBadges\`); the guide below says where each shows and what its content gets. Buttons are \`action(label, command, args)\`; register each command with \`Contributions.command({ id, run: ({ args, memberId }) => ... })\` and decode \`args\` and check what the member may do in \`run\`. A command only administrators should run names \`roles: ['admin']\`; the app then checks the role and hides the button from members. \`related/\` (card and palette), \`standup/\` (palette link) and \`stale/\` (badges) are references.
- Values people should be able to change without a prompt go into \`settings\` in extension.json (per key: "type" string, number (with "min"/"max"), boolean or select (with "options"), a "label" and a "default"); read them while building with \`const settings = yield* ExtensionSettings\` from \`@hyper-effect/jellyware\` (\`settings.number('max')\`, \`settings.string\`, \`settings.boolean\`). \`related/\` declares three. A key for another service is a setting with \"type\": \"secret\" (no default): read it with \`settings.secret(key)\` (a \`Redacted\`; \`Redacted.value\` only where it is used, \`settings.hasSecret(key)\` to test) and never put it in content, pages or logs. A value each member should choose for themselves gets \"scope\": \"member\": read it per member with \`settings.forMember(memberId)\` (a stream of values; \`related/\` does this for \`max\`).
- Each extension runs in a process of its own that can read only its own bundled code, with no network and none of the server's environment; it reaches the app only through the services it is given. Of the app's own services it may use only these members: ${sharedMembers()}. A check also refuses code that reaches beyond the app's services. Import only: ${allowedImports()}. Type-only imports (\`import type\`) of anything are fine. Do not use \`process\`, \`globalThis\`, \`require\`, \`eval\`, \`Function\`, \`fetch\`, \`WebSocket\`, \`import.meta\`, a computed \`import()\`, or Effect's \`Config\`/\`ConfigProvider\`.
- Page \`name\`s and paths, command ids, sidebar entry ids and card ids must be new: the guide below lists every one in use, and which extension owns it.
- Use Tailwind classes the app already uses where you can.
- Data an extension keeps goes into its own SQLite database: declare its tables in extension.json as \`"migrations": ["CREATE TABLE ..."]\` and read and write rows with \`ExtensionData\` from \`@hyper-effect/jellyware\` (\`data.query(sql, params)\`, \`data.run(sql, params)\`, \`data.changes\` to follow writes). Migrations are append-only: never change, remove or reorder one the guide says is applied; add new ones after it. Statements may read and write rows only (no CREATE, DROP, ATTACH or PRAGMA outside migrations). \`pins/\` is the reference.
- Test what you build, in \`<id>/*.test.ts\` next to the code: a page's update with Foldkit's \`Story\` and its view with \`Scene\` (\`foldkit/test\`), pure functions (what a card or a badge shows) with plain assertions; data from \`#app/seed\`. Tests import from \`@effect/vitest\`. The app runs the tests of every extension you change and sends you the failures; they must pass. \`standup/page.test.ts\`, \`stale/extension.test.ts\` and \`related/extension.test.ts\` are references.
- End with two or three sentences on what you changed, then a last line naming every extension folder you created, changed or removed: \`Changed: standup, related\` (or \`Changed: none\`). The app compares it with the files and asks again when they differ.
`

export type PiOptions = Readonly<{
  /** The app's folder (with AGENTS.md and src/). */
  appDirectory: string
  /** The repository root (with .claude/skills). */
  repository: string
  /** Where pi keeps its credentials for this app. */
  agentDirectory: string
}>

const guardModule = fileURLToPath(new URL('../pi-guard.ts', import.meta.url))

/** Folders and files pi never reads under the repository. */
const HIDDEN = ['.jellyware', '.git', '.hyper-sessions*', '.env*']

/** pi's credentials while at least one pi runs: written when the first
 *  starts, deleted when the last stops (runs may work side by side). */
const sharedCredentials = (agentDirectory: string) => {
  let users = 0
  const lock = Semaphore.makeUnsafe(1)
  const acquire = lock.withPermits(1)(
    Effect.gen(function* () {
      if (users === 0) yield* writeCredentials(agentDirectory)
      users += 1
    }),
  )
  const release = lock.withPermits(1)(
    Effect.gen(function* () {
      users -= 1
      if (users === 0) yield* Effect.promise(() => rm(credentialsFile(agentDirectory), { force: true }))
    }),
  )
  return { acquire, release }
}
type Credentials = ReturnType<typeof sharedCredentials>

export const piAgent = (options: PiOptions): Agent => {
  // Credentials left by a server that stopped while pi worked.
  rmSync(credentialsFile(options.agentDirectory), { force: true })
  const credentials = sharedCredentials(options.agentDirectory)
  return { work: task => work(options, credentials, task) }
}

const work = (options: PiOptions, credentials: Credentials, { prompt, stage, runDirectory, feedback, guide, previous, report }: Task) =>
  Effect.gen(function* () {
    // The rules, then what the app has now (made by the app at the run's start).
    const instructionsFile = join(runDirectory, 'instructions.md')
    const text = instructions(options.appDirectory, options.repository) + (guide === null ? '' : `\n${guide}`)
    yield* Effect.promise(() => writeFile(instructionsFile, text))
    // A follow-up's first attempt forks the session of the run before it.
    const fork = previous !== null && feedback === null ? yield* sessionFileOf(previous.runDirectory) : null
    const message =
      feedback !== null
        ? `Your change did not go live. Fix it; here is what failed:\n\n${feedback}`
        : previous === null
          ? prompt
          : [
              `This follows up your earlier change ("${previous.prompt}"), which ${OUTCOME[previous.state]}.`,
              `The current directory is a new copy of the app's extensions as they are now${previous.state === 'installed' ? ', with that change' : ''}.`,
              '',
              prompt,
            ].join('\n')
    const cli = yield* Effect.try({ try: piCli, catch: error => fail(`pi was not found: ${String(error)}`) })
    const guard: Guard = { stage, read: [options.repository], hidden: HIDDEN }
    let answer = ''
    let failure: string | null = null
    const roots = [stage, options.repository]
    // The end of a tool call does not repeat what it worked on.
    const targets = new Map<string, string>()
    const onEvent = (event: PiEvent): Effect.Effect<void> => {
      switch (event.type) {
        case 'tool_execution_start': {
          const target = targetOf(event.args, roots)
          targets.set(event.toolCallId, target)
          return report({ _tag: 'Tool', id: event.toolCallId, name: event.toolName, target, state: 'running', detail: null })
        }
        case 'tool_execution_end': {
          const tool: AgentEvent = {
            _tag: 'Tool',
            id: event.toolCallId,
            name: event.toolName,
            target: targets.get(event.toolCallId) ?? '',
            state: event.isError ? 'failed' : 'done',
            detail: event.isError ? textOf(event.result?.content).slice(0, 600) : null,
          }
          return report(tool)
        }
        case 'message_end': {
          if (event.message.role !== 'assistant') return Effect.void
          if (event.message.stopReason === 'error' || event.message.stopReason === 'aborted') {
            failure = event.message.errorMessage ?? 'pi stopped.'
          }
          const said = textOf(event.message.content)
          if (said === '') return Effect.void
          answer = said
          return report({ _tag: 'Said', text: said })
        }
      }
    }
    const pi = runNodeLines(
      [
        cli,
        '--mode', 'json',
        '--no-approve',
        '--session-dir', join(runDirectory, 'pi'),
        ...(fork === null ? [] : ['--fork', fork]),
        '--session-id', 'run',
        '--provider', 'openai-codex',
        '--model', process.env['JELLYWARE_MODEL'] ?? 'gpt-6.1-sol',
        '--thinking', process.env['JELLYWARE_THINKING'] ?? 'medium',
        '--tools', 'read,edit,write,grep,find,ls',
        '--no-skills',
        '--no-extensions',
        '--extension', guardModule,
        '--no-prompt-templates',
        '--append-system-prompt', instructionsFile,
        message,
      ],
      {
        cwd: stage,
        env: { ...process.env, PI_CODING_AGENT_DIR: options.agentDirectory, JELLYWARE_GUARD: JSON.stringify(guard) },
        timeoutMs: 20 * 60 * 1000,
      },
      line => {
        const event = decodePiEvent(line)
        return Option.isSome(event) ? onEvent(event.value) : Effect.void
      },
    ).pipe(
      Effect.mapError(output => fail(`pi stopped: ${output}`)),
      Effect.flatMap(() =>
        failure !== null && answer === ''
          ? Effect.fail(fail(`pi stopped: ${failure}`))
          : answer === ''
            ? Effect.fail(fail('pi ended without an answer.'))
            : Effect.succeed(answer),
      ),
    )
    // The token exists only while a pi runs.
    return yield* Effect.acquireUseRelease(credentials.acquire, () => pi, () => credentials.release)
  })

/** Typechecks the changed extensions of a snapshot against the app,
 *  incrementally (the first run takes a minute or two). */
/** Typechecks take turns: they share one incremental build file. */
const typecheckTurns = Semaphore.makeUnsafe(1)

export const typecheck = (appDirectory: string, workDirectory: string): Check => ({
  name: 'Typecheck',
  run: input => typecheckTurns.withPermits(1)(typecheckOnce(appDirectory, workDirectory, input)),
})

const typecheckOnce = (
  appDirectory: string,
  workDirectory: string,
  { snapshot, runDirectory, changed }: Readonly<{ snapshot: string; runDirectory: string; changed: ReadonlyArray<string> }>,
) =>
    Effect.gen(function* () {
      const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')
      const config = join(runDirectory, 'tsconfig.json')
      yield* Effect.promise(() =>
        writeFile(
          config,
          JSON.stringify({
            extends: join(appDirectory, 'tsconfig.json'),
            compilerOptions: { incremental: true, tsBuildInfoFile: join(workDirectory, 'tsc.tsbuildinfo') },
            include: changed.map(id => `${relative(runDirectory, join(snapshot, id)).split('\\').join('/')}/**/*`),
          }),
        ),
      )
      yield* runNode([tsc, '--noEmit', '-p', config, '--pretty', 'false'], { cwd: appDirectory, timeoutMs: 10 * 60 * 1000 }).pipe(
        // tsc prints paths relative to the app; the agent knows its stage.
        Effect.mapError(output => {
          const prefixes = [resolve(snapshot), relative(appDirectory, snapshot)].flatMap(path => [
            `${path}\\`,
            `${path.split('\\').join('/')}/`,
          ])
          return prefixes.reduce((text, prefix) => text.split(prefix).join(''), output).slice(0, 6000)
        }),
      )
  })

/** Environment variables the tests get: what Node and the test runner
 *  need, none of the server's secrets. */
const TEST_ENVIRONMENT = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE']

/** Runs the tests (`*.test.ts`) of the changed extensions of a snapshot
 *  with the app's test runner, in a child process whose environment holds
 *  none of the server's variables. An extension without tests passes. */
export const extensionTests = (appDirectory: string): Check => ({
  name: 'Tests',
  run: ({ snapshot, runDirectory, changed }) =>
    Effect.gen(function* () {
      const files = yield* Effect.promise(async () => {
        const found: Array<string> = []
        for (const id of changed) {
          const entries = await readdir(join(snapshot, id), { recursive: true }).catch(() => [])
          for (const entry of entries) if (isTestFile(entry)) found.push(join(snapshot, id, entry))
        }
        return found
      })
      if (files.length === 0) return
      const slash = (path: string) => path.split('\\').join('/')
      const config = join(runDirectory, 'vitest.config.mjs')
      yield* Effect.promise(() =>
        writeFile(
          config,
          `export default ${JSON.stringify({
            resolve: { alias: { '@': slash(join(appDirectory, 'src')) } },
            test: { name: 'extension-tests', root: slash(appDirectory), include: files.map(file => slash(relative(appDirectory, file))) },
          })}\n`,
        ),
      )
      // Its command-line entry (`bin`), which the package does not export.
      const vitest = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs')
      const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' }
      for (const key of TEST_ENVIRONMENT) if (process.env[key] !== undefined) env[key] = process.env[key]
      yield* runNode([vitest, 'run', '--config', config, '--root', appDirectory], { cwd: appDirectory, env, timeoutMs: 5 * 60 * 1000 }).pipe(
        // Paths as the agent knows them: relative to its stage.
        Effect.mapError(output => {
          const prefixes = [resolve(snapshot), relative(appDirectory, snapshot)].flatMap(path => [`${path}\\`, `${slash(path)}/`])
          return prefixes.reduce((text, prefix) => text.split(prefix).join(''), output).slice(-6000)
        }),
      )
    }),
})

/** An agent without a model, for browser checks: a prompt
 *  `replace <file> :: <old> => <new>` replaces text in a stage file. Its
 *  answer names the file's extension as changed. */
export const scriptAgent: Agent = {
  work: ({ prompt, stage, report }) =>
    Effect.gen(function* () {
      const answer = (text: string) => Effect.as(report({ _tag: 'Said', text }), text)
      const match = /^replace (\S+) :: ([\s\S]+?) => ([\s\S]*)$/.exec(prompt.trim())
      if (match === null) return yield* answer('The script agent only knows `replace <file> :: <old> => <new>`.\nChanged: none')
      const [, file = '', from = '', to = ''] = match
      const path = resolve(stage, file)
      if (!path.startsWith(resolve(stage))) return yield* Effect.fail(fail('The file must be in the stage.'))
      const changed = `Changed: ${file.split('/')[0] ?? ''}`
      yield* report({ _tag: 'Tool', id: 'edit', name: 'edit', target: file, state: 'running', detail: null })
      const text = yield* Effect.tryPromise({ try: () => readFile(path, 'utf8'), catch: () => fail(`No file ${file}.`) })
      if (!text.includes(from)) {
        yield* report({ _tag: 'Tool', id: 'edit', name: 'edit', target: file, state: 'failed', detail: 'The text to replace is not in the file.' })
        return yield* answer(`${file} does not contain the text to replace.\n${changed}`)
      }
      yield* Effect.promise(() => writeFile(path, text.split(from).join(to)))
      yield* report({ _tag: 'Tool', id: 'edit', name: 'edit', target: file, state: 'done', detail: null })
      return yield* answer(`Replaced the text in ${file}.\n${changed}`)
    }),
}
