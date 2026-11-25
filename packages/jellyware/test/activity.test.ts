import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, assert, describe, it } from '@effect/vitest'
import { type Context, Effect, Layer, Stream } from 'effect'
import { KeyValueStore } from 'effect/persistence'

import { type Activity, type AgentError, Changes, type Run, type Task, layer as changesLayer } from '../src/changes'
import { Contributions } from '../src/contributions'
import { graph } from '../src/graft'
import { Extensions, layer as loaderLayer } from '../src/loader'

/* What a run shows while it works (what the agent says, the tools it
   calls, the pipeline's steps), conversations of several runs, and turning
   an extension off and on. */

const root = join(import.meta.dirname, '.tmp', `activity-${Date.now()}`)
const live = join(root, 'extensions')
const work = join(root, '.jellyware')
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

export default Layer.effectDiscard(
  Effect.gen(function* () {
    const contributions = yield* Contributions
    yield* contributions.nav({ id: '${id}', label: '${label}', href: '/${id}', icon: 'star' })
  }),
)
`,
  )
}
writeExtension(live, 'hello', 'Hello')

let agent: (task: Task) => Effect.Effect<string, AgentError> = () => Effect.succeed('nothing')
/** The check fails while this is set, with it as the message. */
let checkFails: string | null = null

const app = changesLayer({
  extensionsDirectory: live,
  workDirectory: work,
  review: true,
  agent: { work: task => agent(task) },
  checks: [{ name: 'Typecheck', run: () => (checkFails === null ? Effect.void : Effect.fail(checkFails)) }],
}).pipe(
  Layer.provideMerge(loaderLayer({ directory: live, requires: [Contributions] })),
  Layer.provideMerge(graph),
  Layer.provideMerge(Contributions.layer),
  Layer.provideMerge(KeyValueStore.layerMemory),
)

type Services = Changes | Contributions | Extensions
let context: Context.Context<Services>
const run = <A, E>(effect: Effect.Effect<A, E, Services>) => Effect.runPromise(Effect.provide(effect, context))
const labels = () => run(Effect.flatMap(Contributions, c => c.navEntries)).then(entries => entries.map(entry => entry.label))
const runOf = (id: string) => run(Effect.flatMap(Changes, changes => changes.current)).then(runs => runs.find(other => other.id === id))
const activity = (id: string) =>
  run(Effect.flatMap(Changes, changes => Stream.runHead(changes.activity(id)))).then(head => (head._tag === 'Some' ? head.value : []))
const describeActivity = (entries: ReadonlyArray<Activity>) =>
  entries.map(entry => (entry._tag === 'Said' ? `said ${entry.text}` : entry._tag === 'Tool' ? `tool ${entry.name} ${entry.target} ${entry.state}` : `step ${entry.text} ${entry.state}`))

const waitFor = async (id: string): Promise<Run> => {
  for (let i = 0; i < 800; i++) {
    const found = await runOf(id)
    if (found !== undefined && ['review', 'installed', 'unchanged', 'failed'].includes(found.state)) return found
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Run ${id} did not finish`)
}
const start = (prompt: string, thread?: string) => run(Effect.flatMap(Changes, changes => changes.start(prompt, 'Ada', thread)))

/** An agent that reports reading and writing, then renames hello. */
const renaming = (label: string) => (task: Task) =>
  Effect.gen(function* () {
    yield* task.report({ _tag: 'Tool', id: 'a', name: 'read', target: 'hello/extension.ts', state: 'running', detail: null })
    yield* task.report({ _tag: 'Tool', id: 'a', name: 'read', target: 'hello/extension.ts', state: 'done', detail: null })
    writeExtension(task.stage, 'hello', label)
    yield* task.report({ _tag: 'Said', text: `Called it ${label}.` })
    return `Called it ${label}.`
  })

describe('activity and conversations', () => {
  it('shows what a run does, follows up a conversation, and turns extensions off and on', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        context = yield* Layer.build(app)
        yield* Effect.promise(async () => {
          // A run that fails a check once: the activity tells the story.
          checkFails = 'TS2322: no'
          let attempts = 0
          agent = task => {
            attempts += 1
            if (attempts === 2) checkFails = null
            return renaming('Hi')(task)
          }
          const first = await waitFor(await start('Call it Hi'))
          assert.strictEqual(first.state, 'review')
          assert.strictEqual(first.thread, null)
          const story = describeActivity(await activity(first.id))
          assert.deepStrictEqual(story, [
            'step The agent works on the change done',
            'tool read hello/extension.ts done',
            'said Called it Hi.',
            'step Manifests and credentials done',
            'step Typecheck failed',
            'step Sent back to the agent to fix (attempt 2 of 3) info',
            'step The agent works on what failed (attempt 2) done',
            'tool read hello/extension.ts done',
            'said Called it Hi.',
            'step Manifests and credentials done',
            'step Typecheck done',
            'step Checks passed. Waiting for review: nothing is live yet info',
          ])
          const failedCheck = (await activity(first.id)).find(entry => entry._tag === 'Step' && entry.state === 'failed')
          assert.isTrue(failedCheck?._tag === 'Step' && failedCheck.detail?.includes('TS2322') === true)
          const tool = (await activity(first.id)).find(entry => entry._tag === 'Tool')
          assert.isTrue(tool?._tag === 'Tool' && tool.until !== null)

          // Approval and the install are steps too.
          await run(Effect.flatMap(Changes, changes => changes.approve(first.id, 'Grace')))
          assert.deepStrictEqual(describeActivity(await activity(first.id)).slice(-2), [
            'step Approved by Grace done',
            'step Installed hello: live now done',
          ])
          assert.deepStrictEqual(await labels(), ['Hi'])

          // A follow-up carries on from the run before it in the conversation.
          const seen: Array<Task['previous']> = []
          agent = task => {
            seen.push(task.previous)
            return renaming('Hey')(task)
          }
          const second = await waitFor(await start('Now call it Hey', first.id))
          assert.strictEqual(second.thread, first.id)
          assert.deepStrictEqual(seen.at(-1), { runDirectory: join(work, 'runs', first.id), prompt: 'Call it Hi', state: 'installed', summary: 'Called it Hi.' })
          // A third, named by the second run, joins the same conversation.
          const third = await waitFor(await start('Never mind', second.id))
          assert.strictEqual(third.thread, first.id)
          assert.strictEqual(seen.at(-1)?.prompt, 'Now call it Hey')

          // Not while the agent still works on it; not for a run that does not exist.
          let release: () => void = () => undefined
          let started: () => void = () => undefined
          const working = new Promise<void>(resolve => (started = resolve))
          agent = () =>
            Effect.promise(
              () =>
                new Promise<string>(resolve => {
                  release = () => resolve('Nothing.')
                  started()
                }),
            )
          const busy = await start('Wait', first.id)
          const refused = await run(
            Effect.flatMap(Changes, changes => changes.start('Again', 'Ada', first.id)).pipe(Effect.catchTag('StartRefused', error => Effect.succeed(error.message))),
          )
          assert.include(refused, 'still working')
          await working
          release()
          await waitFor(busy)
          const unknown = await run(
            Effect.flatMap(Changes, changes => changes.start('Again', 'Ada', 'nope')).pipe(Effect.catchTag('StartRefused', error => Effect.succeed(error.message))),
          )
          assert.strictEqual(unknown, 'No run nope.')

          // Off: unloaded, listed as disabled; on: loaded again.
          await run(Effect.flatMap(Extensions, extensions => extensions.setEnabled('hello', false)))
          assert.deepStrictEqual(await labels(), [])
          const off = await run(Effect.flatMap(Extensions, extensions => extensions.current))
          assert.deepStrictEqual(off.map(status => [status.id, status.state, status.running]), [['hello', 'disabled', null]])
          // A reload (a change of its files) keeps it off.
          await run(Effect.flatMap(Extensions, extensions => extensions.reload('hello')))
          assert.deepStrictEqual(await labels(), [])
          await run(Effect.flatMap(Extensions, extensions => extensions.setEnabled('hello', true)))
          assert.deepStrictEqual(await labels(), ['Hi'])
          const missing = await run(
            Effect.flatMap(Extensions, extensions => extensions.setEnabled('nope', false)).pipe(Effect.catch(message => Effect.succeed(message))),
          )
          assert.strictEqual(missing, 'There is no extension nope.')
        })
      }).pipe(Effect.scoped),
    )
  }, 30_000)
})
