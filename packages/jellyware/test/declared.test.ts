import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, assert, describe, it } from '@effect/vitest'
import { type Context, Effect, Layer } from 'effect'
import { KeyValueStore } from 'effect/persistence'

import { AgentError, Changes, type Run, type Task, declaredMismatch, layer as changesLayer, parseDeclared } from '../src/changes'
import { Contributions } from '../src/contributions'
import { graph } from '../src/graft'
import { checkFolder } from '../src/imports'
import { layer as loaderLayer } from '../src/loader'

/* The agent's account of what it changed (after Powermove): its answer
   ends with `Changed: <ids>`, which must name exactly the extensions whose
   folders differ. And test files, which may import the test runner. */

describe('the Changed line', () => {
  it('reads the last Changed line and keeps the rest as the summary', () => {
    assert.deepStrictEqual(parseDeclared('Renamed the entry.\n\nChanged: standup, `related/`'), {
      declared: ['related', 'standup'],
      summary: 'Renamed the entry.',
    })
    assert.deepStrictEqual(parseDeclared('Nothing to do.\nchanged: none.'), { declared: [], summary: 'Nothing to do.' })
    assert.deepStrictEqual(parseDeclared('Done.'), { declared: null, summary: 'Done.' })
  })

  it('says what does not fit', () => {
    assert.isNull(declaredMismatch(['a', 'b'], ['b', 'a']))
    assert.isNull(declaredMismatch([], []))
    assert.include(declaredMismatch(null, ['a']) ?? '', 'End your answer with a line `Changed: <ids>`')
    const text = declaredMismatch(['a', 'c'], ['a', 'b']) ?? ''
    assert.include(text, 'You said you changed a, c, but the files show changes in a, b.')
    assert.include(text, 'Changed but not named: b.')
    assert.include(text, 'Named but unchanged: c.')
  })
})

const root = join(import.meta.dirname, '.tmp', `declared-${Date.now()}`)
const live = join(root, 'extensions')
mkdirSync(live, { recursive: true })
afterAll(() => rmSync(root, { recursive: true, force: true }))

const contributionsModule = join(import.meta.dirname, '..', 'src', 'contributions.ts').replaceAll('\\', '/')

const writeExtension = (folder: string, id: string, label: string) => {
  mkdirSync(join(folder, id), { recursive: true })
  writeFileSync(join(folder, id, 'extension.json'), JSON.stringify({ id, name: id, version: '1', entry: 'extension.ts' }))
  writeFileSync(
    join(folder, id, 'extension.ts'),
    `import { Effect, Layer } from 'effect'
import { Contributions } from '${contributionsModule}'
export default Layer.effectDiscard(Effect.flatMap(Contributions, c => c.nav({ id: '${id}', label: '${label}', href: '/${id}', icon: 'star' })))
`,
  )
}
writeExtension(live, 'hello', 'Hello')

let agent: (task: Task) => Promise<string> = async () => 'nothing'
const tasks: Array<Task> = []

const app = changesLayer({
  extensionsDirectory: live,
  workDirectory: join(root, '.jellyware'),
  declaredChanges: true,
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
  checks: [],
}).pipe(
  Layer.provideMerge(loaderLayer({ directory: live, requires: [Contributions] })),
  Layer.provideMerge(graph),
  Layer.provideMerge(Contributions.layer),
  Layer.provideMerge(KeyValueStore.layerMemory),
)

let context: Context.Context<Changes | Contributions>
const run = <A, E>(effect: Effect.Effect<A, E, Changes | Contributions>) => Effect.runPromise(Effect.provide(effect, context))

const change = async (prompt: string, does: (task: Task) => Promise<string>): Promise<Run> => {
  agent = does
  const id = await run(Effect.flatMap(Changes, changes => changes.start(prompt, 'Ada')))
  for (let i = 0; i < 200; i++) {
    const found = (await run(Effect.flatMap(Changes, changes => changes.current))).find(other => other.id === id)
    if (found !== undefined && ['installed', 'unchanged', 'failed'].includes(found.state)) return found
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Run ${id} did not finish`)
}

describe('changes with declared changes', () => {
  it('asks the agent again when its account does not fit, and installs when it does', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        context = yield* Layer.build(app)
        yield* Effect.promise(async () => {
          // It changed a second extension by mistake and did not say so.
          const fixed = await change('Call it Hi', async task => {
            if (task.feedback === null) {
              writeExtension(task.stage, 'hello', 'Hi')
              writeExtension(task.stage, 'stray', 'Stray')
              return 'Renamed the entry.\nChanged: hello'
            }
            rmSync(join(task.stage, 'stray'), { recursive: true, force: true })
            return 'Removed the stray extension.\nChanged: hello'
          })
          assert.include(tasks.at(-1)?.feedback ?? '', 'Changed but not named: stray.')
          assert.strictEqual(fixed.state, 'installed')
          assert.strictEqual(fixed.attempts, 2)
          assert.strictEqual(fixed.summary, 'Removed the stray extension.')
          assert.deepStrictEqual(fixed.changes.map(each => each.id), ['hello'])

          // Never says what it changed: fails without installing.
          const silent = await change('Call it Hey', async task => {
            writeExtension(task.stage, 'hello', 'Hey')
            return 'Renamed.'
          })
          assert.strictEqual(silent.state, 'failed')
          assert.include(silent.error ?? '', "The agent's account of its changes did not match")
          assert.strictEqual(silent.attempts, 3)

          // Nothing changed, and it says so.
          assert.strictEqual((await change('Look', async () => 'Looked.\nChanged: none')).state, 'unchanged')
        })
      }).pipe(Effect.scoped),
    )
  }, 120_000)
})

describe('test files', () => {
  it('may import what the rules allow for tests, and nothing else more', async () => {
    const folder = join(root, 'tested')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'card.test.ts'), "import { it } from '@effect/vitest'\nimport { readFileSync } from 'node:fs'\n")
    writeFileSync(join(folder, 'card.ts'), "import { it } from '@effect/vitest'\n")
    const problems = await Effect.runPromise(checkFolder(folder, { allow: ['=effect'], testAllow: ['@effect/vitest'] }))
    assert.strictEqual(problems.length, 2)
    assert.isTrue(problems.some(problem => problem.includes('card.ts') && problem.includes('@effect/vitest')))
    assert.isTrue(problems.some(problem => problem.includes('card.test.ts') && problem.includes('node:fs')))
  })
})
