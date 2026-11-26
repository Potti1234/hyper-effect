import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { KeyValueStore } from 'effect/persistence'

import { Changes, type Run, type Task, layer as changesLayer } from '../src/changes'
import { Contributions } from '../src/contributions'
import { graph } from '../src/graft'
import { layer as loaderLayer } from '../src/loader'

/* A run the app stopped during carries on when it starts again: the agent
   gets the stage it left and is told so. With `review`, files outside the
   extensions that changed meanwhile are a warning for the reviewer. */

const root = join(import.meta.dirname, '.tmp', `resume-${Date.now()}`)
const live = join(root, 'extensions')
const work = join(root, '.jellyware')
const appSources = join(root, 'src')
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

mkdirSync(appSources, { recursive: true })
writeFileSync(join(appSources, 'app.ts'), 'export const app = 1\n')
writeExtension(live, 'hello', 'Hello')

// A run left `working` by a server that stopped, with its stage half done.
const runId = '20261126000000-abcd'
const runDirectory = join(work, 'runs', runId)
writeExtension(join(runDirectory, 'stage'), 'hello', 'Half done')
const interrupted: Run = {
  id: runId,
  prompt: 'Rename it',
  author: 'Ada',
  startedAt: 1,
  finishedAt: null,
  state: 'working',
  attempts: 1,
  changes: [],
  summary: null,
  error: null,
  reviewer: null,
  thread: null,
  options: { agent: 'codex' },
  warnings: [],
}
writeFileSync(join(runDirectory, 'run.json'), JSON.stringify(interrupted))

const tasks: Array<Task> = []

const app = changesLayer({
  extensionsDirectory: live,
  workDirectory: work,
  protectedDirectories: [appSources],
  review: true,
  agent: {
    work: task =>
      Effect.sync(() => {
        tasks.push(task)
        // It finishes what it began; meanwhile someone edits the app.
        const before = readFileSync(join(task.stage, 'hello', 'extension.ts'), 'utf8')
        writeFileSync(join(task.stage, 'hello', 'extension.ts'), before.replace('Half done', 'Done'))
        writeFileSync(join(appSources, 'app.ts'), 'export const app = 2\n')
        return 'Finished the rename.'
      }),
  },
  checks: [],
}).pipe(
  Layer.provideMerge(loaderLayer({ directory: live, requires: [Contributions] })),
  Layer.provideMerge(graph),
  Layer.provideMerge(Contributions.layer),
  Layer.provideMerge(KeyValueStore.layerMemory),
)

describe('resume', () => {
  it('carries on a run the app stopped during, and warns of files outside the extensions', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const changes = yield* Changes
        let run: Run | undefined
        for (let i = 0; i < 200 && run?.state !== 'review'; i++) {
          run = (yield* changes.current).find(each => each.id === runId)
          yield* Effect.sleep('25 millis')
        }
        assert.strictEqual(run?.state, 'review')
        assert.isTrue(tasks[0]?.resumed)
        assert.include(tasks[0]?.feedback ?? '', 'restarted')
        assert.deepStrictEqual(tasks[0]?.options, { agent: 'codex' })
        assert.deepStrictEqual(run?.changes.map(change => change.id), ['hello'])
        assert.strictEqual(run?.warnings.length, 1)
        assert.include(run?.warnings[0] ?? '', 'src/app.ts')
      }).pipe(Effect.provide(app), Effect.scoped),
    )
  }, 60_000)
})
