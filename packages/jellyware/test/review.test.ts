import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, assert, describe, it } from '@effect/vitest'
import { type Context, Effect, Layer } from 'effect'
import { KeyValueStore } from 'effect/persistence'

import { AgentError, Changes, type Run, type Task, layer as changesLayer } from '../src/changes'
import { Contributions } from '../src/contributions'
import { diffFile, diffLines } from '../src/diff'
import { graph } from '../src/graft'
import { layer as loaderLayer } from '../src/loader'

/* The change pipeline with review on: a checked run waits until a person
   approves or rejects it, and shows what it would change. */

const root = join(import.meta.dirname, '.tmp', `review-${Date.now()}`)
const live = join(root, 'extensions')
const work = join(root, '.jellyware')
mkdirSync(live, { recursive: true })
afterAll(() => rmSync(root, { recursive: true, force: true }))

const contributionsModule = join(import.meta.dirname, '..', 'src', 'contributions.ts').replaceAll('\\', '/')

const writeExtension = (folder: string, id: string, label: string, build = '') => {
  mkdirSync(join(folder, id), { recursive: true })
  writeFileSync(join(folder, id, 'extension.json'), JSON.stringify({ id, name: id, version: '1', entry: 'extension.ts' }))
  writeFileSync(
    join(folder, id, 'extension.ts'),
    `import { Effect, Layer } from 'effect'
import { Contributions } from '${contributionsModule}'

export default Layer.effectDiscard(
  Effect.gen(function* () {
    ${build}
    const contributions = yield* Contributions
    yield* contributions.nav({ id: '${id}', label: '${label}', href: '/${id}', icon: 'star' })
  }),
)
`,
  )
}
writeExtension(live, 'hello', 'Hello')

let agent: (task: Task) => Promise<string> = async () => 'nothing'

const app = changesLayer({
  extensionsDirectory: live,
  workDirectory: work,
  review: true,
  agent: {
    work: task => Effect.tryPromise({ try: () => agent(task), catch: error => new AgentError({ message: String(error) }) }),
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
const labels = () => run(Effect.flatMap(Contributions, c => c.navEntries)).then(entries => entries.map(entry => entry.label))
const runOf = (id: string) => run(Effect.flatMap(Changes, changes => changes.current)).then(runs => runs.find(other => other.id === id))

/** Starts a run and waits until it waits for review or is over. */
const change = async (prompt: string, does: (task: Task) => Promise<string>): Promise<Run> => {
  agent = does
  const id = await run(Effect.flatMap(Changes, changes => changes.start(prompt, 'Ada')))
  for (let i = 0; i < 200; i++) {
    const found = await runOf(id)
    if (found !== undefined && ['review', 'installed', 'unchanged', 'failed'].includes(found.state)) return found
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Run ${id} did not finish`)
}
const refusal = <A>(effect: Effect.Effect<A, { readonly message: string }, Changes>) =>
  run(effect.pipe(Effect.as('done'), Effect.catch(error => Effect.succeed(error.message))))
const approve = (id: string, reviewer = 'Grace') => refusal(Effect.flatMap(Changes, changes => changes.approve(id, reviewer)))
const reject = (id: string, reviewer = 'Grace') => refusal(Effect.flatMap(Changes, changes => changes.reject(id, reviewer)))
const diff = (id: string) => run(Effect.flatMap(Changes, changes => changes.diff(id)))

describe('changes with review', () => {
  it('waits for approval, shows the diff, installs or rejects', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        context = yield* Layer.build(app)
        yield* Effect.promise(async () => {
          // A checked run waits; nothing is live yet.
          const renamed = await change('Call it Hi', async task => {
            writeExtension(task.stage, 'hello', 'Hi')
            writeFileSync(join(task.stage, 'hello', 'notes.md'), 'A note.\n')
            return 'Renamed.'
          })
          assert.strictEqual(renamed.state, 'review')
          assert.deepStrictEqual(await labels(), ['Hello'])

          // The reviewer sees each changed file.
          const files = await diff(renamed.id)
          assert.deepStrictEqual(files.map(file => [file.path, file.action]), [['extension.ts', 'changed'], ['notes.md', 'added']])
          const lines = files[0]?.lines ?? []
          assert.deepStrictEqual(
            lines.filter(line => line.kind === 'removed' || line.kind === 'added').map(line => `${line.kind} ${line.text.trim()}`),
            [
              "removed yield* contributions.nav({ id: 'hello', label: 'Hello', href: '/hello', icon: 'star' })",
              "added yield* contributions.nav({ id: 'hello', label: 'Hi', href: '/hello', icon: 'star' })",
            ],
          )

          // Approval installs it and records who approved.
          assert.strictEqual(await approve(renamed.id), 'done')
          const approved = await runOf(renamed.id)
          assert.strictEqual(approved?.state, 'installed')
          assert.strictEqual(approved?.reviewer, 'Grace')
          assert.deepStrictEqual(await labels(), ['Hi'])
          assert.include(await approve(renamed.id), 'this one is installed')
          // The diff stays readable afterwards.
          assert.strictEqual((await diff(renamed.id)).length, 2)

          // A run that only adds an extension shows its files too.
          const added = await change('Add a second entry', async task => {
            writeExtension(task.stage, 'second', 'Second')
            return 'Added.'
          })
          assert.deepStrictEqual((await diff(added.id)).map(file => [file.extension, file.path, file.action]), [
            ['second', 'extension.json', 'added'],
            ['second', 'extension.ts', 'added'],
          ])
          assert.strictEqual(await reject(added.id), 'done')

          // A rejected run changes nothing.
          const rejected = await change('Call it Hey', async task => {
            writeExtension(task.stage, 'hello', 'Hey')
            return 'Renamed.'
          })
          assert.strictEqual(await reject(rejected.id), 'done')
          assert.strictEqual((await runOf(rejected.id))?.state, 'rejected')
          assert.include(await approve(rejected.id), 'this one is rejected')
          assert.deepStrictEqual(await labels(), ['Hi'])

          // A live extension changed while the run waited: approval fails, the hand edit stays.
          const stale = await change('Call it Yo', async task => {
            writeExtension(task.stage, 'hello', 'Yo')
            return 'Renamed.'
          })
          writeExtension(live, 'hello', 'Edited by hand')
          assert.strictEqual(await approve(stale.id), 'done')
          const failed = await runOf(stale.id)
          assert.strictEqual(failed?.state, 'failed')
          assert.include(failed?.error ?? '', 'changed since this run started')
          assert.include(readFileSync(join(live, 'hello', 'extension.ts'), 'utf8'), 'Edited by hand')

          // An extension that fails to build at approval is put back.
          for (let i = 0; i < 100 && !(await labels()).includes('Edited by hand'); i++) await new Promise(resolve => setTimeout(resolve, 25))
          const broken = await change('Add a database', async task => {
            writeExtension(task.stage, 'hello', 'With database', "yield* Effect.fail('no database')")
            return 'Done.'
          })
          assert.strictEqual(await approve(broken.id), 'done')
          const unbuilt = await runOf(broken.id)
          assert.strictEqual(unbuilt?.state, 'failed')
          assert.include(unbuilt?.error ?? '', 'no database')
          assert.include(readFileSync(join(live, 'hello', 'extension.ts'), 'utf8'), 'Edited by hand')
        })
      }).pipe(Effect.scoped),
    )
  }, 120_000)
})

describe('diff', () => {
  it('finds the changed lines and keeps three lines around them', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`)
    const after = [...before.slice(0, 10), 'new line', ...before.slice(11)]
    const file = diffFile('x', 'a.ts', Buffer.from(before.join('\n') + '\n'), Buffer.from(after.join('\n') + '\n'))
    assert.deepStrictEqual(
      file?.lines?.map(line => `${line.kind}:${line.text}`),
      [
        'gap:7 unchanged lines',
        'same:line 7',
        'same:line 8',
        'same:line 9',
        'removed:line 10',
        'added:new line',
        'same:line 11',
        'same:line 12',
        'same:line 13',
        'gap:6 unchanged lines',
      ],
    )
    assert.strictEqual(file?.added, 1)
    assert.strictEqual(file?.removed, 1)
  })

  it('handles added, removed, equal and binary files', () => {
    assert.isNull(diffFile('x', 'a', Buffer.from('same'), Buffer.from('same')))
    assert.strictEqual(diffFile('x', 'a', null, Buffer.from('one\ntwo'))?.added, 2)
    assert.strictEqual(diffFile('x', 'a', Buffer.from('one\r\n'), null)?.action, 'removed')
    assert.isNull(diffFile('x', 'a.png', Buffer.from([0, 1]), Buffer.from([0, 2]))?.lines)
    assert.deepStrictEqual(
      diffLines(['a', 'b', 'c', 'd'], ['a', 'c', 'x', 'd']).map(edit => `${edit.kind[0]}${edit.text}`),
      ['sa', 'rb', 'sc', 'ax', 'sd'],
    )
  })
})
