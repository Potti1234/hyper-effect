import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readdir, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'

import { Effect, Semaphore } from 'effect'
import ts from 'typescript'

import type { Check } from './changes.ts'
import { isTestFile } from './imports.ts'

/* The checks most apps give the change pipeline: a typecheck of the changed
   extensions against the app, and their own tests. A run's snapshot may lie
   anywhere (`workDirectory`), so the configurations they write resolve
   everything from the app's folder: its types (`@types`), its tsconfig
   `paths` and its package.json `imports` (`#app/*`), as absolute paths.
   Messages name files as the agent knows them: relative to its stage. */

export type CheckOptions = Readonly<{
  /** The app's folder: its package.json, tsconfig.json and node_modules. */
  appDirectory: string
  /** Where the typecheck keeps its incremental build file. */
  workDirectory: string
  /** Default ten minutes for the typecheck, five for the tests. */
  timeoutMs?: number
}>

const slash = (path: string) => path.split('\\').join('/')

/** Runs a Node program; answers with stdout, fails with the end of its output. */
const runNode = (args: ReadonlyArray<string>, options: Readonly<{ cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number }>) =>
  Effect.callback<string, string>(resume => {
    const child = spawn(process.execPath, [...args], { cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += String(chunk)))
    child.stderr.on('data', chunk => (stderr += String(chunk)))
    const timer = setTimeout(() => child.kill(), options.timeoutMs)
    child.on('error', error => resume(Effect.fail(String(error))))
    child.on('close', code => {
      clearTimeout(timer)
      resume(code === 0 ? Effect.succeed(stdout) : Effect.fail(`${(stderr || stdout).slice(-6000)}\n(exit ${code})`))
    })
    return Effect.sync(() => child.kill())
  })

/** Output with the snapshot's paths made relative to it. */
const relativeToStage = (output: string, appDirectory: string, snapshot: string) =>
  [resolve(snapshot), relative(appDirectory, snapshot)]
    .flatMap(path => [`${path}\\`, `${slash(path)}/`])
    .reduce((text, prefix) => text.split(prefix).join(''), output)

/** The app's package imports (`"imports": { "#app/*": "./src/app/*.ts" }`)
 *  as absolute patterns. */
export const packageImports = (appDirectory: string): ReadonlyArray<Readonly<{ from: string; to: string }>> => {
  const file = join(appDirectory, 'package.json')
  if (!existsSync(file)) return []
  const imports: unknown = JSON.parse(readFileSync(file, 'utf8')).imports
  if (typeof imports !== 'object' || imports === null) return []
  return Object.entries(imports).flatMap(([from, to]) => (typeof to === 'string' ? [{ from, to: slash(resolve(appDirectory, to)) }] : []))
}

/** The app's tsconfig `paths`, absolute. */
const tsconfigPaths = (appDirectory: string): Record<string, ReadonlyArray<string>> => {
  const file = join(appDirectory, 'tsconfig.json')
  const read = ts.readConfigFile(file, ts.sys.readFile)
  const options: unknown = read.config?.compilerOptions
  const paths: unknown = typeof options === 'object' && options !== null && 'paths' in options ? options.paths : undefined
  const base = typeof options === 'object' && options !== null && 'baseUrl' in options && typeof options.baseUrl === 'string' ? resolve(appDirectory, options.baseUrl) : appDirectory
  if (typeof paths !== 'object' || paths === null) return {}
  return Object.fromEntries(
    Object.entries(paths).map(([key, targets]) => [key, (Array.isArray(targets) ? targets : []).map(target => slash(resolve(base, String(target))))]),
  )
}

const requireFrom = (appDirectory: string) => createRequire(join(appDirectory, 'package.json'))

/** A snapshot outside the app finds the app's packages through a link to
 *  its node_modules in the run's folder (the snapshot lies in it). */
const linkModules = (app: string, snapshot: string, runDirectory: string) =>
  Effect.promise(async () => {
    if (!relative(app, snapshot).startsWith('..')) return
    const link = join(runDirectory, 'node_modules')
    if (existsSync(link)) return
    await symlink(join(app, 'node_modules'), link, 'junction').catch(() => undefined)
  })

const typecheckTurns = Semaphore.makeUnsafe(1)

/** Typechecks the changed extensions of a snapshot against the app, with
 *  the app's tsconfig (incrementally: the first run takes longer). */
export const typecheckCheck = (options: CheckOptions): Check => ({
  name: 'Typecheck',
  run: ({ snapshot, runDirectory, changed }) =>
    typecheckTurns.withPermits(1)(
      Effect.gen(function* () {
        const app = resolve(options.appDirectory)
        const tsc = (() => {
          try {
            return requireFrom(app).resolve('typescript/bin/tsc')
          } catch {
            return createRequire(import.meta.url).resolve('typescript/bin/tsc')
          }
        })()
        yield* linkModules(app, snapshot, runDirectory)
        const config = join(runDirectory, 'tsconfig.json')
        const paths = {
          ...tsconfigPaths(app),
          ...Object.fromEntries(packageImports(app).map(({ from, to }) => [from, [to]])),
        }
        yield* Effect.promise(() =>
          writeFile(
            config,
            JSON.stringify({
              extends: slash(join(app, 'tsconfig.json')),
              compilerOptions: {
                incremental: true,
                tsBuildInfoFile: slash(join(resolve(options.workDirectory), 'tsc.tsbuildinfo')),
                // From the app, wherever the snapshot is (`@types/node`, and
                // type packages such as `vite/client`).
                typeRoots: [slash(join(app, 'node_modules', '@types')), slash(join(app, 'node_modules'))],
                paths,
              },
              include: changed.map(id => `${slash(relative(runDirectory, join(snapshot, id)))}/**/*`),
            }),
          ),
        )
        yield* runNode([tsc, '--noEmit', '-p', config, '--pretty', 'false'], { cwd: app, timeoutMs: options.timeoutMs ?? 10 * 60 * 1000 }).pipe(
          Effect.mapError(output => relativeToStage(output, app, snapshot).slice(0, 6000)),
        )
      }),
    ),
})

/** What Node and the test runner need of the environment; none of the
 *  server's secrets reach the tests. */
const TEST_ENVIRONMENT = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE']

/** Runs the tests (`*.test.ts`) of the changed extensions with the app's
 *  vitest, in a child process without the server's environment. An
 *  extension without tests passes. */
export const testsCheck = (options: CheckOptions): Check => ({
  name: 'Tests',
  run: ({ snapshot, runDirectory, changed }) =>
    Effect.gen(function* () {
      const app = resolve(options.appDirectory)
      const files = yield* Effect.promise(async () => {
        const found: Array<string> = []
        for (const id of changed) {
          const entries = await readdir(join(snapshot, id), { recursive: true }).catch(() => [])
          for (const entry of entries) if (isTestFile(entry)) found.push(join(snapshot, id, entry))
        }
        return found
      })
      if (files.length === 0) return
      yield* linkModules(app, snapshot, runDirectory)
      const aliases = [
        ...Object.entries(tsconfigPaths(app)).flatMap(([key, targets]) => {
          const target = targets[0]
          return target === undefined || !key.endsWith('/*') ? [] : [{ find: `^${key.slice(0, -2).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(.*)$`, replacement: target.replace('*', '$1') }]
        }),
        ...packageImports(app).flatMap(({ from, to }) =>
          from.endsWith('/*') ? [{ find: `^${from.slice(0, -2).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(.*)$`, replacement: to.replace('*', '$1') }] : [],
        ),
      ]
      const config = join(runDirectory, 'vitest.config.mjs')
      yield* Effect.promise(() =>
        writeFile(
          config,
          [
            'export default {',
            `  resolve: { alias: [${aliases.map(alias => `{ find: new RegExp(${JSON.stringify(alias.find)}), replacement: ${JSON.stringify(alias.replacement)} }`).join(', ')}] },`,
            `  test: { name: 'extension-tests', root: ${JSON.stringify(slash(app))}, include: ${JSON.stringify(files.map(file => slash(relative(snapshot, file))))} },`,
            '}',
            '',
          ].join('\n'),
        ),
      )
      const vitest = join(dirname(requireFrom(app).resolve('vitest/package.json')), 'vitest.mjs')
      const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' }
      for (const key of TEST_ENVIRONMENT) if (process.env[key] !== undefined) env[key] = process.env[key]
      yield* runNode([vitest, 'run', '--config', config, '--root', app, '--dir', slash(snapshot)], { cwd: app, env, timeoutMs: options.timeoutMs ?? 5 * 60 * 1000 }).pipe(
        Effect.mapError(output => relativeToStage(output, app, snapshot).slice(-6000)),
      )
    }),
})
