import { execFileSync, spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Effect, Schema as S } from 'effect'

import { type Agent, AgentError, type Check, type Task } from '@hyper-effect/jellyware'

import type { Guard } from '../pi-guard.ts'
import { importRules } from './extension-rules.ts'

/* The agent that changes this app's extensions, and the typecheck its work
   must pass.

   The agent is pi (https://github.com/badlogic/pi-mono), run once per
   attempt in print mode, in the run's stage folder, with file tools only
   (read, edit, write, grep, find, ls; no shell). A retry continues the same
   pi session with what failed. The pi extension in src/pi-guard.ts limits
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
- To add something to an issue page instead of a page of its own, show a card in the slot under the issue's properties: \`issueSidebar(id, context => stream of SlotContent)\` with buttons made by \`action(label, command, args)\`, and register each command with \`Contributions.command({ id, run: ({ args, memberId }) => ... })\`; decode \`args\` and check what the member may do in \`run\`. \`related/\` in the current directory is the reference.
- Values people should be able to change without a prompt go into \`settings\` in extension.json (per key: "type" string, number (with "min"/"max"), boolean or select (with "options"), a "label" and a "default"); read them while building with \`const settings = yield* ExtensionSettings\` from \`@hyper-effect/jellyware\` (\`settings.number('max')\`, \`settings.string\`, \`settings.boolean\`). \`related/\` declares three.
- Extensions run inside the app's server, so a check refuses code that reaches beyond the app's services. Import only: ${allowedImports()}. Type-only imports (\`import type\`) of anything are fine. Do not use \`process\`, \`globalThis\`, \`require\`, \`eval\`, \`Function\`, \`fetch\`, \`WebSocket\`, \`import.meta\`, a computed \`import()\`, or Effect's \`Config\`/\`ConfigProvider\`.
- Page \`name\`s and paths must not collide with the app's pages (issues, issue, /team, /issue, /issues, /my-issues) or other extensions.
- Use Tailwind classes the app already uses where you can.
- End with two or three sentences on what you changed.
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

export const piAgent = (options: PiOptions): Agent => {
  // Credentials left by a server that stopped while pi worked.
  rmSync(credentialsFile(options.agentDirectory), { force: true })
  return { work: task => work(options, task) }
}

const work = (options: PiOptions, { prompt, stage, runDirectory, feedback }: Task) =>
  Effect.gen(function* () {
    const instructionsFile = join(runDirectory, 'instructions.md')
    yield* Effect.promise(() => writeFile(instructionsFile, instructions(options.appDirectory, options.repository)))
    const message =
      feedback === null
        ? prompt
        : `Your change did not go live. Fix it; here is what failed:\n\n${feedback}`
    const cli = yield* Effect.try({ try: piCli, catch: error => fail(`pi was not found: ${String(error)}`) })
    const guard: Guard = { stage, read: [options.repository], hidden: HIDDEN }
    const pi = runNode(
      [
        cli,
        '--print',
        '--no-approve',
        '--session-dir', join(runDirectory, 'pi'),
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
    ).pipe(
      Effect.map(output => output.trim()),
      Effect.mapError(output => fail(`pi stopped: ${output}`)),
    )
    // The token exists only while pi runs.
    return yield* Effect.acquireUseRelease(
      writeCredentials(options.agentDirectory),
      () => pi,
      () => Effect.promise(() => rm(credentialsFile(options.agentDirectory), { force: true })),
    )
  })

/** Typechecks the changed extensions of a snapshot against the app,
 *  incrementally (the first run takes a minute or two). */
export const typecheck = (appDirectory: string, workDirectory: string): Check => ({
  name: 'Typecheck',
  run: ({ snapshot, runDirectory, changed }) =>
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
    }),
})

/** An agent without a model, for browser checks: a prompt
 *  `replace <file> :: <old> => <new>` replaces text in a stage file. */
export const scriptAgent: Agent = {
  work: ({ prompt, stage }) =>
    Effect.gen(function* () {
      const match = /^replace (\S+) :: ([\s\S]+?) => ([\s\S]*)$/.exec(prompt.trim())
      if (match === null) return 'The script agent only knows `replace <file> :: <old> => <new>`.'
      const [, file = '', from = '', to = ''] = match
      const path = resolve(stage, file)
      if (!path.startsWith(resolve(stage))) return yield* Effect.fail(fail('The file must be in the stage.'))
      const text = yield* Effect.tryPromise({ try: () => readFile(path, 'utf8'), catch: () => fail(`No file ${file}.`) })
      if (!text.includes(from)) return `${file} does not contain the text to replace.`
      yield* Effect.promise(() => writeFile(path, text.split(from).join(to)))
      return `Replaced the text in ${file}.`
    }),
}
