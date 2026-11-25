import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, assert, describe, it } from '@effect/vitest'
import { type Context, Effect, Layer } from 'effect'
import { KeyValueStore } from 'effect/persistence'

import { AgentError, Changes, type Run, type Task, layer as changesLayer } from '../src/changes'
import { Contributions } from '../src/contributions'
import { graph } from '../src/graft'
import { layer as loaderLayer } from '../src/loader'

/* Runs side by side: with `concurrency: 2`, two runs work at once and a
   third waits; both install; two runs that change the same extension
   cannot both go live. */

const root = join(import.meta.dirname, '.tmp', `concurrency-${Date.now()}`)
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
writeExtension(live, 'shared', 'Shared')

// Agents wait until released, so the test sees which ones work at once.
let working = 0
let mostAtOnce = 0
/** Finishes the agent working on a prompt, by its first word. */
const releases = new Map<string, () => void>()
const release = (word: string) => {
  const finish = releases.get(word)
  releases.delete(word)
  finish?.()
}
const agent = (task: Task) =>
  new Promise<string>(resolve => {
    working += 1
    mostAtOnce = Math.max(mostAtOnce, working)
    const [, id = '', label = ''] = /^(\S+) (.*)$/.exec(task.prompt) ?? []
    releases.set(label.includes('fourth') ? 'fourth' : id, () => {
      writeExtension(task.stage, id, label)
      working -= 1
      resolve('Done.')
    })
  })

const app = changesLayer({
  extensionsDirectory: live,
  workDirectory: join(root, '.jellyware'),
  concurrency: 2,
  agent: { work: task => Effect.tryPromise({ try: () => agent(task), catch: error => new AgentError({ message: String(error) }) }) },
  checks: [],
}).pipe(
  Layer.provideMerge(loaderLayer({ directory: live, requires: [Contributions] })),
  Layer.provideMerge(graph),
  Layer.provideMerge(Contributions.layer),
  Layer.provideMerge(KeyValueStore.layerMemory),
)

let context: Context.Context<Changes | Contributions>
const run = <A, E>(effect: Effect.Effect<A, E, Changes | Contributions>) => Effect.runPromise(Effect.provide(effect, context))
const runs = () => run(Effect.flatMap(Changes, changes => changes.current))
const stateOf = async (id: string) => (await runs()).find(other => other.id === id)?.state
const waitFor = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 400 && !(await check()); i++) await new Promise(resolve => setTimeout(resolve, 25))
}
const finished = (id: string) => waitFor(async () => ['installed', 'failed', 'unchanged'].includes((await stateOf(id)) ?? ''))
const start = (prompt: string) => run(Effect.flatMap(Changes, changes => changes.start(prompt, 'Ada')))

describe('runs side by side', () => {
  it('works on two runs at once, queues the third, and refuses a second change of the same extension', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        context = yield* Layer.build(app)
        yield* Effect.promise(async () => {
          const first = await start('one One')
          const second = await start('two Two')
          const third = await start('shared Changed by the third')
          await waitFor(() => working === 2)
          assert.strictEqual(working, 2)
          assert.strictEqual(await stateOf(third), 'queued')

          // The second finishes first and installs; the third starts.
          release('two')
          await finished(second)
          assert.strictEqual(await stateOf(second), 'installed')
          await waitFor(() => working === 2)
          assert.strictEqual(await stateOf(first), 'working')
          assert.notStrictEqual(await stateOf(third), 'queued')

          // A fourth run on the same extension as the third: whichever
          // installs second is refused, so no change is lost silently.
          const fourth = await start('shared Changed by the fourth')
          release('one')
          await finished(first)
          await waitFor(() => working === 2)
          release('shared')
          await finished(third)
          await waitFor(() => releases.has('fourth'))
          release('fourth')
          await finished(fourth)
          const done: ReadonlyArray<Run> = await runs()
          const byId = (id: string) => done.find(other => other.id === id)!
          assert.strictEqual(byId(first).state, 'installed')
          assert.strictEqual(byId(third).state, 'installed')
          assert.strictEqual(byId(fourth).state, 'failed')
          assert.include(byId(fourth).error ?? '', 'shared changed since this run started')
          assert.strictEqual(mostAtOnce, 2)
        })
      }).pipe(Effect.scoped),
    )
  }, 60_000)
})
