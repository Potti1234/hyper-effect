import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, assert, describe, it } from '@effect/vitest'
import { type Context, Effect, Layer } from 'effect'
import { KeyValueStore } from 'effect/persistence'

import { AgentError, Changes, type Run, type Task, layer as changesLayer } from '../src/changes'
import { Contributions } from '../src/contributions'
import { graph } from '../src/graft'
import { layer as loaderLayer } from '../src/loader'

/* The change pipeline with a scripted agent: each test sets what the agent
   does to the stage. Single-file extensions, as in loader.test.ts. */

const root = join(import.meta.dirname, '.tmp', `changes-${Date.now()}`)
const live = join(root, 'extensions')
const work = join(root, '.jellyware')
const appSources = join(root, 'src')
mkdirSync(live, { recursive: true })
mkdirSync(appSources, { recursive: true })
writeFileSync(join(appSources, 'app.ts'), 'export const app = 1\n')
// Only this file's folder: test files run in parallel.
afterAll(() => rmSync(root, { recursive: true, force: true }))

const contributionsModule = join(import.meta.dirname, '..', 'src', 'contributions.ts').replaceAll('\\', '/')

const extensionSource = (id: string, label: string, build = '') => `
import { Effect, Layer } from 'effect'
import { Contributions } from '${contributionsModule}'

export default Layer.effectDiscard(
  Effect.gen(function* () {
    ${build}
    const contributions = yield* Contributions
    yield* contributions.nav({ id: '${id}', label: '${label}', href: '/${id}', icon: 'star' })
  }),
)
`
const writeExtension = (folder: string, id: string, label: string, build = '') => {
  mkdirSync(join(folder, id), { recursive: true })
  writeFileSync(
    join(folder, id, 'extension.json'),
    JSON.stringify({ id, name: id, version: '1', entry: 'extension.ts' }),
  )
  writeFileSync(join(folder, id, 'extension.ts'), extensionSource(id, label, build))
}
writeExtension(live, 'hello', 'Hello')

/** What the agent does next; set by each test. */
let agent: (task: Task) => Promise<string> = async () => 'nothing'
const tasks: Array<Task> = []

const app = changesLayer({
  extensionsDirectory: live,
  workDirectory: work,
  protectedDirectories: [appSources],
  attempts: 2,
  agent: {
    work: task =>
      Effect.tryPromise({
        try: () => {
          tasks.push(task)
          return agent(task)
        },
        catch: error => new AgentError({ message: String(error) }),
      }),
  },
  checks: [
    {
      name: 'Typecheck',
      run: ({ snapshot, changed }) =>
        Effect.suspend(() => {
          const bad = changed.filter(id => readFileSync(join(snapshot, id, 'extension.ts'), 'utf8').includes('TYPE ERROR'))
          return bad.length === 0 ? Effect.void : Effect.fail(`${bad.join(', ')}: TS2322 TYPE ERROR`)
        }),
    },
  ],
}).pipe(
  Layer.provideMerge(loaderLayer({ directory: live, requires: [Contributions] })),
  Layer.provideMerge(graph),
  Layer.provideMerge(Contributions.layer),
  Layer.provideMerge(KeyValueStore.layerMemory),
)

let context: Context.Context<Changes | Contributions>
const run = <A, E>(effect: Effect.Effect<A, E, Changes | Contributions>) => Effect.runPromise(Effect.provide(effect, context))
const labels = () => run(Effect.flatMap(Contributions, c => c.navEntries)).then(entries => entries.map(entry => entry.label))

/** Starts a run and waits until it is over. */
const change = async (prompt: string, does: (task: Task) => Promise<string>): Promise<Run> => {
  agent = does
  const id = await run(Effect.flatMap(Changes, changes => changes.start(prompt, 'Ada')))
  for (let i = 0; i < 200; i++) {
    const found = (await run(Effect.flatMap(Changes, changes => changes.current))).find(other => other.id === id)
    if (found !== undefined && ['installed', 'unchanged', 'failed', 'undone'].includes(found.state)) return found
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Run ${id} did not finish`)
}
const undo = (id: string) =>
  run(Effect.flatMap(Changes, changes => changes.undo(id)).pipe(Effect.as('done' as const), Effect.catchTag('UndoRefused', error => Effect.succeed(error.message))))

describe('changes', () => {
  it('stages, checks, installs, retries, undoes and refuses', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        context = yield* Layer.build(app)
        yield* Effect.promise(async () => {
          assert.deepStrictEqual(await labels(), ['Hello'])

          // The agent edits the stage; the change goes live.
          const renamed = await change('Call it Hi', async task => {
            assert.isNull(task.feedback)
            writeExtension(task.stage, 'hello', 'Hi')
            return 'Renamed the entry.'
          })
          assert.strictEqual(renamed.state, 'installed')
          assert.strictEqual(renamed.summary, 'Renamed the entry.')
          assert.deepStrictEqual(renamed.changes.map(c => [c.id, c.action]), [['hello', 'changed']])
          assert.deepStrictEqual(await labels(), ['Hi'])
          assert.include(readFileSync(join(live, 'hello', 'extension.ts'), 'utf8'), "'Hi'")

          // A failed check goes back to the agent, which fixes it.
          const retried = await change('Call it Hey', async task => {
            writeExtension(task.stage, 'hello', task.feedback === null ? 'TYPE ERROR' : 'Hey')
            return task.feedback === null ? 'First try.' : 'Fixed the type error.'
          })
          assert.strictEqual(retried.state, 'installed')
          assert.strictEqual(retried.attempts, 2)
          assert.include(tasks.at(-1)?.feedback ?? '', 'TS2322')
          assert.deepStrictEqual(await labels(), ['Hey'])

          // An extension that fails to build is put back, and the agent hears why.
          const rebuilt = await change('Add a database', async task => {
            writeExtension(task.stage, 'hello', 'With database', task.feedback === null ? "yield* Effect.fail('no database')" : '')
            return 'Done.'
          })
          assert.strictEqual(rebuilt.state, 'installed')
          assert.strictEqual(rebuilt.attempts, 2)
          assert.include(tasks.at(-1)?.feedback ?? '', 'no database')
          assert.deepStrictEqual(await labels(), ['With database'])

          // Nothing changed: nothing to install.
          const unchanged = await change('Just look', async () => 'Looked.')
          assert.strictEqual(unchanged.state, 'unchanged')

          // A new extension.
          const added = await change('Add a second entry', async task => {
            writeExtension(task.stage, 'second', 'Second')
            return 'Added.'
          })
          assert.deepStrictEqual(added.changes.map(c => [c.id, c.action]), [['second', 'added']])
          assert.deepStrictEqual(await labels(), ['With database', 'Second'])

          // Undo goes newest first.
          assert.include(await undo(retried.id), 'Undo the newer runs first')
          assert.strictEqual(await undo(added.id), 'done')
          assert.isFalse(existsSync(join(live, 'second')))
          assert.deepStrictEqual(await labels(), ['With database'])
          assert.strictEqual(await undo(rebuilt.id), 'done')
          assert.deepStrictEqual(await labels(), ['Hey'])
          assert.include(await undo(rebuilt.id), 'this one is undone')

          // A credential never goes live, however often the agent tries.
          const secret = await change('Add my key', async task => {
            writeExtension(task.stage, 'hello', 'sk-abcdefghijklmnopqrstuvwxyz123456')
            return 'Added the key.'
          })
          assert.strictEqual(secret.state, 'failed')
          assert.strictEqual(secret.attempts, 2)
          assert.include(secret.error ?? '', 'credential')
          assert.deepStrictEqual(await labels(), ['Hey'])

          // The agent must stay in the stage.
          const outside = await change('Change the app', async task => {
            writeFileSync(join(appSources, 'app.ts'), 'export const app = 2\n')
            writeExtension(task.stage, 'hello', 'Outside')
            return 'Changed the app.'
          })
          assert.strictEqual(outside.state, 'failed')
          assert.include(outside.error ?? '', 'outside the extensions')
          assert.deepStrictEqual(await labels(), ['Hey'])

          // A live extension changed meanwhile: the run is refused.
          const conflict = await change('Rename again', async task => {
            writeExtension(live, 'hello', 'Edited by hand')
            writeExtension(task.stage, 'hello', 'From the agent')
            return 'Renamed.'
          })
          assert.strictEqual(conflict.state, 'failed')
          assert.include(conflict.error ?? '', 'changed while the agent worked')
        })
      }).pipe(Effect.scoped),
    )
  }, 120_000)
})
