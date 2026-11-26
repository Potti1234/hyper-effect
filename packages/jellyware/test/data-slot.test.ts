import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, Fiber, Layer, Schema as S, Scope, Stream, SubscriptionRef } from 'effect'

import { Contributions } from '../src/contributions'
import { dataSlot } from '../src/data-slot'

/* Data slots: values of the app's own shape, typed by a Schema, per
   context; a value that fails or does not fit is left out. */

const Tool = S.Struct({ name: S.String, description: S.String, input: S.Json })
const Tools = dataSlot('agent.tools', Tool)
const Instructions = dataSlot('agent.instructions', S.String)
const Since = dataSlot('since', S.Date)

describe('data slots', () => {
  it.live('adds, reads per context, replaces and removes values', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const text = yield* SubscriptionRef.make('Be brief.')
      yield* Instructions.add('style', context => SubscriptionRef.changes(text).pipe(Stream.map(value => `${value} (${context['threadId']})`))).pipe(
        Scope.provide(scope),
      )
      yield* Tools.add('remember', () => Stream.make({ name: 'remember', description: 'Keeps a fact.', input: { type: 'object' } }))
      assert.deepStrictEqual(yield* Instructions.current({ threadId: 't1' }), [{ id: 'style', value: 'Be brief. (t1)' }])
      assert.deepStrictEqual(yield* Tools.current({}), [{ id: 'remember', value: { name: 'remember', description: 'Keeps a fact.', input: { type: 'object' } } }])

      // A change of the value reaches readers.
      const values = yield* Instructions.read({ threadId: 't2' }).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild)
      yield* Effect.sleep('20 millis')
      yield* SubscriptionRef.set(text, 'Answer in German.')
      assert.deepStrictEqual(
        (yield* Fiber.join(values)).map(list => list[0]?.value),
        ['Be brief. (t2)', 'Answer in German. (t2)'],
      )

      // Its scope closed: gone.
      yield* Scope.close(scope, Exit.void)
      assert.deepStrictEqual(yield* Instructions.current({ threadId: 't1' }), [])
    }).pipe(Effect.provide(Contributions.layer), Effect.scoped),
  )

  it.live('encodes values as JSON, and leaves out what fails', () =>
    Effect.gen(function* () {
      const contributions = yield* Contributions
      yield* Since.add('start', () => Stream.make(new Date('2026-11-26T00:00:00Z')))
      // Raw values from another source: one fits, one does not, one fails.
      yield* contributions.data({ slot: 'since', id: 'raw', content: () => Stream.make('2026-11-27T00:00:00.000Z') })
      yield* contributions.data({ slot: 'since', id: 'bad', content: () => Stream.make(42) })
      yield* contributions.data({ slot: 'since', id: 'broken', content: () => Stream.die('bug') })
      assert.deepStrictEqual(yield* contributions.slotData('since', {}).pipe(Stream.runHead, Effect.map(head => (head._tag === 'Some' ? head.value.map(each => each.id) : []))), ['start', 'raw', 'bad'])
      const read = yield* Since.current({})
      assert.deepStrictEqual(read.map(each => [each.id, each.value.toISOString()]), [
        ['start', '2026-11-26T00:00:00.000Z'],
        ['raw', '2026-11-27T00:00:00.000Z'],
      ])
      assert.deepStrictEqual((yield* contributions.inventory).data.map(each => each.id), ['start', 'raw', 'bad', 'broken'])
    }).pipe(Effect.provide(Layer.merge(Contributions.make({ cardTimeout: '100 millis' }), Layer.empty)), Effect.scoped),
  )
})
