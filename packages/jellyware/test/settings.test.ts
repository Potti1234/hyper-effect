import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, assert, describe, it } from '@effect/vitest'
import { type Context, Effect, Layer } from 'effect'
import { KeyValueStore } from 'effect/persistence'

import { Contributions } from '../src/contributions'
import { graph } from '../src/graft'
import { Extensions, layer } from '../src/loader'
import { parseInput } from '../src/settings'

/* Settings of an extension: declared in its manifest, changed while it
   runs, put back when the extension fails with them, undone newest first. */

const directory = join(import.meta.dirname, '.tmp', `settings-${Date.now()}`)
// Only this file's folder: test files run in parallel.
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const here = (file: string) => join(import.meta.dirname, '..', 'src', file).replaceAll('\\', '/')

mkdirSync(join(directory, 'greeter'), { recursive: true })
writeFileSync(
  join(directory, 'greeter', 'extension.json'),
  JSON.stringify({
    id: 'greeter',
    name: 'Greeter',
    version: '1',
    entry: 'extension.ts',
    settings: {
      label: { type: 'string', label: 'Label', default: 'Hello' },
      count: { type: 'number', label: 'Count', default: 1, min: 1, max: 20 },
      loud: { type: 'boolean', label: 'Loud', default: false },
      tone: { type: 'select', label: 'Tone', default: 'warm', options: ['warm', 'dry'] },
    },
  }),
)
// It refuses more than 10: a value that fits the declaration but that the
// extension fails with.
writeFileSync(
  join(directory, 'greeter', 'extension.ts'),
  `
import { Effect, Layer } from 'effect'
import { Contributions } from '${here('contributions.ts')}'
import { ExtensionSettings } from '${here('settings.ts')}'

export default Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ExtensionSettings
    if (settings.number('count') > 10) return yield* Effect.fail('too many greetings')
    const label = settings.string('label') + '!'.repeat(settings.number('count'))
    const contributions = yield* Contributions
    yield* contributions.nav({ id: 'greeter', label: settings.boolean('loud') ? label.toUpperCase() : label, href: '/g', icon: 'star' })
  }),
)
`,
)

const app = layer({ directory, requires: [Contributions] }).pipe(
  Layer.provideMerge(graph),
  Layer.provideMerge(Contributions.layer),
  Layer.provideMerge(KeyValueStore.layerMemory),
)

let context: Context.Context<Extensions | Contributions>
const run = <A, E>(effect: Effect.Effect<A, E, Extensions | Contributions>) => Effect.runPromise(Effect.provide(effect, context))
const label = () => run(Effect.flatMap(Contributions, c => c.navEntries)).then(entries => entries[0]?.label)
const configure = (input: Record<string, string>) =>
  run(Effect.flatMap(Extensions, e => e.configure('greeter', input, 'Ada')).pipe(Effect.result))
const undo = (id: string) => run(Effect.flatMap(Extensions, e => e.undoSettings(id)).pipe(Effect.result))
const status = () => run(Effect.flatMap(Extensions, e => e.current)).then(list => list.find(s => s.id === 'greeter'))

describe('settings', () => {
  it('reads form text as typed values and refuses what does not fit', () => {
    const specs = {
      count: { type: 'number' as const, label: 'Count', default: 1, min: 1, max: 20 },
      loud: { type: 'boolean' as const, label: 'Loud', default: false },
      tone: { type: 'select' as const, label: 'Tone', default: 'warm', options: ['warm', 'dry'] },
    }
    assert.deepStrictEqual(parseInput(specs, { count: '3', loud: 'true', tone: 'dry' }), { values: { count: 3, loud: true, tone: 'dry' } })
    const refused = parseInput(specs, { count: '0', tone: 'cold', other: 'x' })
    assert.isTrue('errors' in refused)
    assert.deepStrictEqual('errors' in refused ? refused.errors : [], [
      '"other" is not a setting of this extension.',
      'Count must be at least 1.',
      'Tone must be one of warm, dry.',
    ])
  })

  it('applies a change, puts back one the extension fails with, and undoes newest first', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        context = yield* Layer.build(app)
        yield* Effect.promise(async () => {
          assert.strictEqual(await label(), 'Hello!')
          assert.deepStrictEqual((await status())?.settings.map(field => [field.key, field.value]), [
            ['label', 'Hello'],
            ['count', 1],
            ['loud', false],
            ['tone', 'warm'],
          ])

          const first = await configure({ label: 'Hi', count: '3' })
          assert.strictEqual(first._tag, 'Success')
          const applied = first._tag === 'Success' ? first.success : undefined
          assert.strictEqual(applied?.state, 'applied')
          assert.strictEqual(await label(), 'Hi!!!')

          const second = await configure({ loud: 'true' })
          assert.strictEqual(await label(), 'HI!!!')

          // Fits the declaration (at most 20), but the extension refuses it.
          const failing = await configure({ count: '12' })
          const reverted = failing._tag === 'Success' ? failing.success : undefined
          assert.strictEqual(reverted?.state, 'reverted')
          assert.include(reverted?.error ?? '', 'too many greetings')
          assert.strictEqual(await label(), 'HI!!!')
          assert.strictEqual((await status())?.settings.find(field => field.key === 'count')?.value, 3)
          assert.strictEqual((await status())?.state, 'active')

          // Refused before anything is stored.
          const invalid = await configure({ count: '50' })
          assert.strictEqual(invalid._tag === 'Failure' ? invalid.failure : '', 'Count must be at most 20.')
          assert.strictEqual((await configure({ count: '3' }))._tag, 'Failure')

          // Undo: the newest applied change first.
          const tooEarly = await undo(applied!.id)
          assert.strictEqual(tooEarly._tag === 'Failure' ? tooEarly.failure : '', 'Undo the newer change of this extension first.')
          assert.strictEqual((await undo(second._tag === 'Success' ? second.success.id : ''))._tag, 'Success')
          assert.strictEqual(await label(), 'Hi!!!')
          assert.strictEqual((await undo(applied!.id))._tag, 'Success')
          assert.strictEqual(await label(), 'Hello!')

          const history = await run(Effect.flatMap(Extensions, e => e.currentSettingsChanges))
          assert.deepStrictEqual(history.map(change => change.state), ['reverted', 'undone', 'undone'])
        })
      }).pipe(Effect.scoped),
    )
  }, 60_000)
})
