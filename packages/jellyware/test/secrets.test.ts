import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, assert, describe, it } from '@effect/vitest'
import { type Context, Effect, Layer, Redacted, Stream } from 'effect'
import { KeyValueStore } from 'effect/persistence'

import { Contributions } from '../src/contributions'
import { graph } from '../src/graft'
import { Extensions, layer } from '../src/loader'
import { decrypt, encrypt } from '../src/secrets'

/* Secret settings (stored encrypted, given to the extension as Redacted,
   shown only as set or not set) and member settings (a default from the
   administrator, each member's own value read while the extension runs). */

const directory = join(import.meta.dirname, '.tmp', `secrets-${Date.now()}`)
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const here = (file: string) => join(import.meta.dirname, '..', 'src', file).replaceAll('\\', '/')

mkdirSync(join(directory, 'inbox'), { recursive: true })
writeFileSync(
  join(directory, 'inbox', 'extension.json'),
  JSON.stringify({
    id: 'inbox',
    name: 'Inbox',
    version: '1',
    entry: 'extension.ts',
    settings: {
      token: { type: 'secret', label: 'Token' },
      max: { type: 'number', label: 'Shown', default: 5, min: 1, max: 20, scope: 'member' },
    },
  }),
)
// The sidebar label shows whether the token reached the extension, and its
// length (never the token); the slot shows each member's `max`.
writeFileSync(
  join(directory, 'inbox', 'extension.ts'),
  `
import { Effect, Layer, Redacted, Stream } from 'effect'
import { Contributions } from '${here('contributions.ts')}'
import { ExtensionSettings } from '${here('settings.ts')}'

export default Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* ExtensionSettings
    const contributions = yield* Contributions
    const label = settings.hasSecret('token') ? 'token ' + Redacted.value(settings.secret('token')).length : 'no token'
    yield* contributions.nav({ id: 'inbox', label, href: '/inbox', icon: 'inbox' })
    yield* contributions.slot({
      slot: 's',
      id: 'inbox',
      content: context =>
        settings.forMember(context['memberId'] ?? '').pipe(
          Stream.map(values => ({ title: String(values.number('max')), items: [], actions: [], note: null })),
        ),
    })
  }),
)
`,
)

const secretKey = Redacted.make('test key')
const store = KeyValueStore.layerMemory
const app = layer({ directory, requires: [Contributions], secretKey }).pipe(
  Layer.provideMerge(graph),
  Layer.provideMerge(Contributions.layer),
  Layer.provideMerge(store),
)

let context: Context.Context<Extensions | Contributions | KeyValueStore.KeyValueStore>
const run = <A, E>(effect: Effect.Effect<A, E, Extensions | Contributions | KeyValueStore.KeyValueStore>) =>
  Effect.runPromise(Effect.provide(effect, context))
const label = () => run(Effect.flatMap(Contributions, c => c.navEntries)).then(entries => entries[0]?.label)
const shown = (memberId: string) =>
  run(Effect.flatMap(Contributions, c => Stream.runHead(c.slotCards('s', { memberId })))).then(head =>
    head._tag === 'Some' ? head.value[0]?.content.title : undefined,
  )
const waitFor = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 200 && !(await check()); i++) await new Promise(resolve => setTimeout(resolve, 25))
}

describe('secrets at rest', () => {
  it('opens only with the same key', () => {
    const stored = encrypt(secretKey, 'sk-live')
    assert.notInclude(stored, 'sk-live')
    assert.strictEqual(decrypt(secretKey, stored), 'sk-live')
    assert.isNull(decrypt(Redacted.make('other key'), stored))
    assert.notStrictEqual(encrypt(secretKey, 'sk-live'), stored)
  })
})

describe('secret and member settings', () => {
  it('gives a secret only to the extension, and each member their own values', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        context = yield* Layer.build(app)
        yield* Effect.promise(async () => {
          await waitFor(async () => (await label()) === 'no token')
          assert.strictEqual(await label(), 'no token')

          // Set: the extension gets it; nothing else shows it.
          const set = await run(Effect.flatMap(Extensions, e => e.configure('inbox', { token: 'sk-1234567890' }, 'Ada')))
          assert.strictEqual(set.state, 'applied')
          assert.strictEqual(await label(), 'token 13')
          const status = (await run(Effect.flatMap(Extensions, e => e.current)))[0]!
          assert.deepStrictEqual(status.settings.find(field => field.key === 'token'), {
            key: 'token',
            spec: { type: 'secret', label: 'Token' },
            value: '',
            isSet: true,
          })
          const history = await run(Effect.flatMap(Extensions, e => e.currentSettingsChanges))
          const everything = JSON.stringify({ status, history, set })
          assert.notInclude(everything, 'sk-1234567890')
          assert.notInclude(everything, 'enc:v1:')
          assert.match(String(history[0]?.after['token']), /^\(secret [0-9a-f]{6}\)$/)
          const stored = await run(Effect.flatMap(KeyValueStore.KeyValueStore, kv => kv.get('jellyware/settings/inbox')))
          assert.notInclude(stored ?? '', 'sk-1234567890')

          // Left empty in the form: kept. Cleared: gone. Undo brings it back.
          assert.strictEqual(
            (await run(Effect.flatMap(Extensions, e => e.configure('inbox', { token: '' }, 'Ada')).pipe(Effect.flip))),
            'Nothing changed.',
          )
          const cleared = await run(Effect.flatMap(Extensions, e => e.clearSecrets('inbox', ['token'], 'Ada')))
          assert.strictEqual(await label(), 'no token')
          await run(Effect.flatMap(Extensions, e => e.undoSettings(cleared.id)))
          assert.strictEqual(await label(), 'token 13')
          assert.include(
            await run(Effect.flatMap(Extensions, e => e.clearSecrets('inbox', ['max'], 'Ada')).pipe(Effect.flip)),
            'not a secret setting',
          )

          // Member settings: the default, then a member's own, without a new build.
          const generation = (await run(Effect.flatMap(Extensions, e => e.current)))[0]!.running
          assert.strictEqual(await shown('grace'), '5')
          await run(Effect.flatMap(Extensions, e => e.configureMember('inbox', 'grace', { max: '2' })))
          assert.strictEqual(await shown('grace'), '2')
          assert.strictEqual(await shown('ada'), '5')
          assert.strictEqual((await run(Effect.flatMap(Extensions, e => e.current)))[0]!.running, generation)
          const mine = await run(Effect.flatMap(Extensions, e => Stream.runHead(e.memberSettings('grace'))))
          assert.deepStrictEqual(
            mine._tag === 'Some' ? mine.value.map(each => [each.extension, each.fields.map(field => [field.key, field.value]), each.own]) : null,
            [['inbox', [['max', 2]], ['max']]],
          )
          // Only member settings, only values that fit.
          assert.include(
            await run(Effect.flatMap(Extensions, e => e.configureMember('inbox', 'grace', { token: 'x' })).pipe(Effect.flip)),
            'not a setting',
          )
          assert.include(
            await run(Effect.flatMap(Extensions, e => e.configureMember('inbox', 'grace', { max: '50' })).pipe(Effect.flip)),
            'at most 20',
          )
          // The administrator's default changes everyone who has no value of their own.
          await run(Effect.flatMap(Extensions, e => e.configure('inbox', { max: '7' }, 'Ada')))
          await waitFor(async () => (await shown('ada')) === '7')
          assert.strictEqual(await shown('ada'), '7')
          assert.strictEqual(await shown('grace'), '2')
          await run(Effect.flatMap(Extensions, e => e.resetMember('inbox', 'grace')))
          assert.strictEqual(await shown('grace'), '7')
        })
      }).pipe(Effect.scoped),
    )
  }, 60_000)
})
