import { assert, describe, it } from '@effect/vitest'
import { Effect, Fiber, Stream } from 'effect'

import { Contributions } from '../src/contributions'

/* One stream per slot and context, shared by every reader: an extension's
   content runs once however many pages show it, and stops a while after
   the last reader left. */

describe('shared slot streams', () => {
  it.live('runs content once for readers of the same context', () =>
    Effect.gen(function* () {
      const contributions = yield* Contributions
      const started: Array<string> = []
      let stopped = 0
      yield* contributions.slot({
        slot: 's',
        id: 'counter',
        content: context =>
          Stream.make({ title: `For ${context['who']}`, items: [], actions: [], note: null }).pipe(
            Stream.concat(Stream.never),
            Stream.onStart(Effect.sync(() => started.push(context['who'] ?? ''))),
            Stream.ensuring(Effect.sync(() => (stopped += 1))),
          ),
      })
      const read = (who: string) => contributions.slotCards('s', { who }, { shared: true }).pipe(Stream.take(1), Stream.runCollect)

      // Three readers at once, two contexts: two streams.
      const fibers = yield* Effect.forEach(['ada', 'ada', 'grace'], who => Effect.forkChild(read(who)))
      const results = yield* Effect.forEach(fibers, Fiber.join)
      assert.deepStrictEqual(results.map(cards => cards[0]?.[0]?.content.title), ['For ada', 'For ada', 'For grace'])
      assert.deepStrictEqual([...started].sort(), ['ada', 'grace'])

      // A reader within the keep time gets the running stream.
      yield* read('ada')
      assert.strictEqual(started.length, 2)

      // After it, the streams stop; a new reader starts one again.
      yield* Effect.sleep('400 millis')
      assert.strictEqual(stopped, 2)
      yield* read('ada')
      assert.strictEqual(started.length, 3)
    }).pipe(Effect.provide(Contributions.make({ keepShared: '200 millis' })), Effect.scoped),
  )
})
