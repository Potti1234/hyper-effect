import { assert, describe, it } from '@effect/vitest'
import { Data, Effect, Exit, Fiber, Scope, Stream } from 'effect'

import { type Handler, type Port, make } from '../src/isolation/bridge'

/* The channel between the server and an extension's process, with two
   in-memory ends: calls, streams, scoped registrations, failures that keep
   their tag, and what happens when the other end goes. */

class NotFound extends Data.TaggedError('NotFound')<{ readonly id: string }> {}

/** Two connected ends; `close` ends the connection for both. */
const pair = () => {
  const listeners: [Array<(message: unknown) => void>, Array<(message: unknown) => void>] = [[], []]
  const closers: [Array<(reason: string) => void>, Array<(reason: string) => void>] = [[], []]
  const end = (self: 0 | 1): Port => ({
    // Like IPC: delivered later, as a copy.
    send: message => setTimeout(() => listeners[self === 0 ? 1 : 0].forEach(listener => listener(structuredClone(message)))),
    onMessage: handler => listeners[self].push(handler),
    onClose: handler => closers[self].push(handler),
  })
  return { a: end(0), b: end(1), close: () => closers.flat().forEach(closer => closer('test closed')) }
}

describe('bridge', () => {
  it.live('calls, streams and holds registrations across the channel', () =>
    Effect.gen(function* () {
      const { a, b, close } = pair()
      const held: Array<string> = []
      const handlers = new Map<string, Handler>([
        ['add', { kind: 'call', run: ([x, y]) => Effect.succeed(Number(x) + Number(y)) }],
        ['find', { kind: 'call', run: ([id]) => Effect.fail(new NotFound({ id: String(id) })) }],
        ['crash', { kind: 'call', run: () => Effect.die('boom') }],
        ['count', { kind: 'stream', open: ([to]) => Stream.range(1, Number(to)) }],
        ['forever', { kind: 'stream', open: () => Stream.never }],
        [
          'hold',
          {
            kind: 'scoped',
            acquire: ([name]) =>
              Effect.acquireRelease(
                Effect.sync(() => held.push(String(name))),
                () => Effect.sync(() => held.splice(held.indexOf(String(name)), 1)),
              ),
          },
        ],
      ])
      const server = yield* make(a, handlers)
      const client = yield* make(b, new Map())

      assert.strictEqual(yield* client.call('add', [2, 3]), 5)
      const error = yield* Effect.flip(client.call('find', ['ENG-9']))
      assert.deepStrictEqual(error, { _tag: 'NotFound', id: 'ENG-9', message: '' })
      // Still a tagged failure on this side.
      assert.strictEqual(
        yield* client.call('find', ['x']).pipe(
          Effect.catch(failure => Effect.succeed(typeof failure === 'object' && failure !== null && '_tag' in failure ? failure._tag : 'untagged')),
        ),
        'NotFound',
      )
      assert.isTrue(Exit.isFailure(yield* Effect.exit(client.call('crash'))))
      assert.include(String(Exit.isFailure(yield* Effect.exit(client.call('nothing')))), 'true')
      assert.deepStrictEqual(yield* Stream.runCollect(client.stream('count', [4])), [1, 2, 3, 4])

      const scope = yield* Scope.make()
      yield* client.scoped('hold', ['sidebar']).pipe(Scope.provide(scope))
      assert.deepStrictEqual(held, ['sidebar'])
      yield* Scope.close(scope, Exit.void)
      yield* Effect.sleep('20 millis')
      assert.deepStrictEqual(held, [])

      // The other end goes: a stream waiting on it dies, registrations end.
      yield* client.scoped('hold', ['page']).pipe(Scope.provide(yield* Scope.make()))
      const waiting = yield* Stream.runDrain(client.stream('forever')).pipe(Effect.exit, Effect.forkChild)
      yield* Effect.sleep('20 millis')
      close()
      const ended = yield* Fiber.join(waiting)
      assert.isTrue(Exit.isFailure(ended))
      yield* Effect.sleep('20 millis')
      assert.deepStrictEqual(held, [])
      assert.strictEqual(yield* server.closed, 'test closed')
      assert.isTrue(Exit.isFailure(yield* Effect.exit(client.call('add', [1, 1]))))
    }).pipe(Effect.scoped),
  )
})
