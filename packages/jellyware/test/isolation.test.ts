import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, assert, describe, it } from '@effect/vitest'
import { Effect, Layer, Stream, SubscriptionRef } from 'effect'
import { KeyValueStore } from 'effect/persistence'

import { PageHost } from '@hyper-effect/core'

import { Contributions } from '../src/contributions'
import { graph } from '../src/graft'
import { Extensions, layer } from '../src/loader'
import { Counter, NotAllowed, remoteServices } from './fixtures/isolation-services'

/* Extensions in a process of their own: built against stand-ins of the
   app's services, their entries in the server's registry, their content and
   commands answered by the process, its file system and network closed, and
   a watchdog that stops a process that no longer answers. */

const root = join(import.meta.dirname, '.tmp', `isolation-${Date.now()}`)
const directory = join(root, 'extensions')
mkdirSync(join(directory, 'counter'), { recursive: true })
afterAll(() => rmSync(root, { recursive: true, force: true }))

const fixture = join(import.meta.dirname, 'fixtures', 'isolation-services.ts').replaceAll('\\', '/')
const secretFile = join(root, 'secret.txt')
writeFileSync(secretFile, 'not for extensions')

writeFileSync(
  join(directory, 'counter', 'extension.json'),
  JSON.stringify({ id: 'counter', name: 'Counter', version: '1', entry: 'extension.ts' }),
)
writeFileSync(
  join(directory, 'counter', 'extension.ts'),
  `
import { readFileSync } from 'node:fs'
import { Effect, Layer, Stream } from 'effect'
import { Contributions } from '@hyper-effect/jellyware'
import { Counter } from '${fixture}'

export default Layer.effectDiscard(
  Effect.gen(function* () {
    const contributions = yield* Contributions
    const counter = yield* Counter
    yield* contributions.nav({ id: 'counter', label: 'Count ' + (yield* counter.current), href: '/counter', icon: 'star' })
    yield* contributions.slot({
      slot: 's',
      id: 'counter',
      content: () => counter.changes.pipe(Stream.map(n => ({ title: 'Count ' + n, items: [], actions: [], note: process.pid === undefined ? null : 'pid ' + process.pid }))),
    })
    yield* contributions.data({ slot: 'd', id: 'counter', content: context => counter.changes.pipe(Stream.map(n => ({ count: n, for: context['who'] ?? null }))) })
    yield* contributions.command({
      id: 'counter.add',
      run: ({ args }) =>
        counter.add(Number((args as { n: number }).n)).pipe(
          Effect.map(n => 'Now ' + n),
          Effect.catchTag('NotAllowed', error => Effect.fail('Refused: ' + error.reason)),
        ),
    })
    yield* contributions.command({
      id: 'counter.read',
      run: () => Effect.try({ try: () => readFileSync(${JSON.stringify(secretFile.replaceAll('\\', '/'))}, 'utf8'), catch: error => String((error as { code?: string }).code) }),
    })
    yield* contributions.command({
      id: 'counter.where',
      run: ({ context }) => Effect.succeed('for ' + (context?.['thread'] ?? 'nobody')),
    })
    yield* contributions.command({
      id: 'counter.block',
      run: () => Effect.sync(() => { const end = Date.now() + 60_000; while (Date.now() < end); return 'never' }),
    })
  }),
)
`,
)

const counter = Layer.effect(
  Counter,
  Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make(0)
    return Counter.of({
      current: SubscriptionRef.get(ref),
      changes: SubscriptionRef.changes(ref),
      add: n =>
        n > 5
          ? Effect.fail(new NotAllowed({ reason: 'at most 5 at once' }))
          : SubscriptionRef.updateAndGet(ref, value => value + n),
    })
  }),
)

const pageHost = Layer.succeed(
  PageHost,
  PageHost.of({ mount: () => Effect.void, mountRoutes: () => Effect.void, names: Effect.succeed([]), pages: Effect.succeed([]) }),
)

const app = layer({
  directory,
  requires: [Contributions, Counter],
  isolation: {
    bundleDirectory: join(root, 'bundles'),
    services: remoteServices,
    servicesModule: fixture,
    identify: () => Effect.succeed(undefined),
    // Extension processes never load SQLite: their data goes through the server.
    forbidden: ['node:sqlite'],
    heartbeat: '200 millis',
    deadline: '1 second',
  },
}).pipe(
  Layer.provideMerge(graph),
  Layer.provideMerge(Contributions.layer),
  Layer.provideMerge(Layer.mergeAll(counter, pageHost, KeyValueStore.layerMemory)),
)

const until = <A>(effect: Effect.Effect<A>, done: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 300; i++) {
      const value = yield* effect
      if (done(value)) return value
      yield* Effect.sleep('50 millis')
    }
    return yield* effect
  })

describe('extensions in a process of their own', () => {
  it.live('serve the registry from the process, keep the file system closed, and stop when they hang', () =>
    Effect.gen(function* () {
      const contributions = yield* Contributions
      const extensions = yield* Extensions
      const status = () => Effect.map(extensions.current, list => list.find(each => each.id === 'counter'))

      const running = yield* until(status(), found => found?.state === 'active' || found?.state === 'failed')
      assert.strictEqual(running?.state, 'active', running?.error ?? '')
      assert.isTrue(running?.isolated)
      assert.deepStrictEqual((yield* contributions.navEntries).map(entry => entry.label), ['Count 0'])

      // Content and commands are answered by the process.
      const first = yield* Stream.runHead(contributions.slotCards('s', {}))
      const card = first._tag === 'Some' ? first.value[0]?.content : undefined
      assert.strictEqual(card?.title, 'Count 0')
      assert.notStrictEqual(card?.note, `pid ${process.pid}`)
      assert.strictEqual(yield* contributions.run('counter.add', { args: { n: 2 }, memberId: 'ada' }), 'Now 2')
      // The caller's context crosses to the process.
      assert.strictEqual(yield* contributions.run('counter.where', { args: null, memberId: 'ada', context: { thread: 't1' } }), 'for t1')
      assert.strictEqual(yield* contributions.run('counter.where', { args: null, memberId: 'ada' }), 'for nobody')
      assert.strictEqual(
        yield* Effect.flip(contributions.run('counter.add', { args: { n: 9 }, memberId: 'ada' })),
        'Refused: at most 5 at once',
      )
      const later = yield* Stream.runHead(contributions.slotCards('s', {}))
      assert.strictEqual(later._tag === 'Some' ? later.value[0]?.content.title : undefined, 'Count 2')
      // A data slot's value crosses as JSON, with the context.
      const data = yield* Stream.runHead(contributions.slotData('d', { who: 'ada' }))
      assert.deepStrictEqual(data._tag === 'Some' ? data.value : undefined, [{ id: 'counter', value: { count: 2, for: 'ada' } }])

      // Its file system is its bundle.
      assert.strictEqual(yield* Effect.flip(contributions.run('counter.read', { args: null, memberId: 'ada' })), 'ERR_ACCESS_DENIED')

      // A command that blocks its event loop: the watchdog stops the process.
      yield* contributions.run('counter.block', { args: null, memberId: 'ada' }).pipe(Effect.ignore, Effect.forkChild)
      const stopped = yield* until(status(), found => found?.state === 'failed')
      assert.strictEqual(stopped?.state, 'failed')
      assert.include(stopped?.error ?? '', 'did not answer')
      assert.deepStrictEqual(yield* contributions.navEntries, [])
    }).pipe(Effect.provide(app), Effect.scoped),
    60_000,
  )
})
