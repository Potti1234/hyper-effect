import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, assert, describe, it } from '@effect/vitest'
import { type Context, Effect, Layer } from 'effect'

import { Contributions } from '../src/contributions'
import { graph } from '../src/graft'
import { Extensions, layer } from '../src/loader'

/* The loader against a folder of extensions written by the test. Under
   vitest, modules are imported by Vite's runner, so only single-file
   extensions are used here; a folder of several modules is imported again
   through Node's resolve hook, which the example app's browser check covers. */

const directory = join(import.meta.dirname, '.tmp', `run-${Date.now()}`)
mkdirSync(directory, { recursive: true })
// Only this file's folder: test files run in parallel.
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const contributionsModule = join(import.meta.dirname, '..', 'src', 'contributions.ts').replaceAll('\\', '/')

const write = (id: string, body: string, manifest: Partial<Record<string, string>> = {}) => {
  mkdirSync(join(directory, id), { recursive: true })
  writeFileSync(
    join(directory, id, 'extension.json'),
    JSON.stringify({ id, name: `Extension ${id}`, version: '1', entry: 'extension.ts', ...manifest }),
  )
  writeFileSync(join(directory, id, 'extension.ts'), body)
}

/** An extension adding one sidebar entry; `build` runs before it. */
const navExtension = (id: string, label: string, build = '') => `
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

write('hello', navExtension('hello', 'Hello'))
write('typo', navExtension('typo', 'Typo'), { id: 'other' })

const app = layer({ directory, requires: [Contributions] }).pipe(
  Layer.provideMerge(graph),
  Layer.provideMerge(Contributions.layer),
)

const run = <A, E>(effect: Effect.Effect<A, E, Extensions | Contributions>) =>
  Effect.runPromise(Effect.provide(effect, context))
let context: Context.Context<Extensions | Contributions>

const status = (id: string) =>
  run(Effect.flatMap(Extensions, extensions => extensions.current)).then(list => list.find(entry => entry.id === id))
const labels = () =>
  run(Effect.flatMap(Contributions, contributions => contributions.navEntries)).then(entries =>
    entries.map(entry => entry.label),
  )
const reload = (id: string) => run(Effect.flatMap(Extensions, extensions => extensions.reload(id)))

describe('loader', () => {
  it('loads, swaps, keeps the running version on failure, and unloads', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        context = yield* Layer.build(app)
        yield* Effect.promise(async () => {
          assert.deepStrictEqual(await labels(), ['Hello'])
          const hello = await status('hello')
          assert.strictEqual(hello?.state, 'active')
          assert.strictEqual(hello?.running, 1)

          // A manifest whose id differs from its folder is refused.
          const typo = await status('typo')
          assert.strictEqual(typo?.state, 'failed')
          assert.include(typo?.error ?? '', 'differs from the folder name')

          // A new version replaces the old one's entry.
          write('hello', navExtension('hello', 'Hello again'))
          await reload('hello')
          assert.deepStrictEqual(await labels(), ['Hello again'])
          assert.strictEqual((await status('hello'))?.running, 2)

          // A version that fails to build leaves the running one in place.
          write('hello', navExtension('hello', 'Broken', "yield* Effect.fail('no database')"))
          await reload('hello')
          assert.deepStrictEqual(await labels(), ['Hello again'])
          const failed = await status('hello')
          assert.strictEqual(failed?.state, 'failed')
          assert.strictEqual(failed?.running, 2)
          assert.include(failed?.error ?? '', 'no database')

          // So does one that does not import.
          write('hello', 'export default {')
          await reload('hello')
          assert.deepStrictEqual(await labels(), ['Hello again'])
          assert.include((await status('hello'))?.error ?? '', 'Importing extension.ts failed')

          // A default export that is not a Layer.
          write('hello', 'export default 42')
          await reload('hello')
          assert.include((await status('hello'))?.error ?? '', 'no Layer as its default export')

          // A new extension appears on reload.
          write('second', navExtension('second', 'Second'))
          await reload('second')
          assert.deepStrictEqual(await labels(), ['Hello again', 'Second'])

          // Removing a folder unloads the extension and its entries.
          rmSync(join(directory, 'hello'), { recursive: true })
          await reload('hello')
          assert.deepStrictEqual(await labels(), ['Second'])
          assert.isUndefined(await status('hello'))
        })
      }).pipe(Effect.scoped),
    )
  })
})
