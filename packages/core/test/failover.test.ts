import { afterEach, assert, describe, it } from '@effect/vitest'
import { Context, Effect } from 'effect'
import { KeyValueStore } from 'effect/persistence'

import type * as Hyper from '../src/server'
import { makeStore, openPage, openStream, postEvent, readUntil, serve, token } from '../src/testing'

import { program } from './fixtures/greeter'

/* Phase A2: a process that fails loses no event its page was told about.
   Two servers share one store; the second stands in for the process that
   takes over, and sees a session exactly as its snapshot left it. */

const increment = (q: number) => ({ m: token({ _tag: 'ClickedIncrement' }), q })

/** A memory store whose writes take `delayMillis` and are counted. */
const slowStore = (delayMillis: number) => {
  const inner = Context.get(makeStore(), KeyValueStore.KeyValueStore)
  const counter = { writes: 0 }
  const store = KeyValueStore.make({
    get: inner.get,
    getUint8Array: inner.getUint8Array,
    remove: inner.remove,
    clear: inner.clear,
    size: inner.size,
    keys: inner.keys,
    set: (key, value) =>
      Effect.sync(() => {
        counter.writes += 1
      }).pipe(Effect.andThen(Effect.sleep(delayMillis)), Effect.andThen(inner.set(key, value))),
  })
  return { counter, store: Context.make(KeyValueStore.KeyValueStore, store) }
}

const countOn = async (handler: Parameters<typeof openStream>[0], page: Parameters<typeof openStream>[1]) => {
  const text = await readUntil(await openStream(handler, page), '</title>')
  return Number(text.match(/hyper-effect \((\d+)\)/)?.[1])
}

describe('failover', () => {
  const servers: Array<{ dispose: () => Promise<void> }> = []
  const pair = (options: Hyper.Options, store: Context.Context<KeyValueStore.KeyValueStore>) => {
    const served = { ...program, name: 'failover' }
    const first = serve(served, { ...options, node: 'w1' }, store)
    const second = serve(served, { ...options, node: 'w2' }, store)
    servers.push(first, second)
    return [first, second] as const
  }
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.dispose()))
  })

  it('an answered event is in the store, for the process that takes over', async () => {
    const [w1, w2] = pair({}, makeStore())
    const page = await openPage(w1.handler)
    assert.strictEqual((await postEvent(w1.handler, page, increment(1))).status, 204)
    // No waiting for a snapshot: the answer promised it.
    assert.strictEqual(await countOn(w2.handler, page), 1)
  })

  it('drops a retry on the process that takes over, and applies what follows', async () => {
    const [w1, w2] = pair({}, makeStore())
    const page = await openPage(w1.handler)
    await postEvent(w1.handler, page, increment(1))
    // The answer to 1 was lost in the failure; the page retries it on w2.
    assert.strictEqual((await postEvent(w2.handler, page, increment(1))).status, 204)
    assert.strictEqual((await postEvent(w2.handler, page, increment(2))).status, 204)
    assert.strictEqual(await countOn(w2.handler, page), 2)
  })

  it('answers an event held behind a gap once the gap closes, then durably', async () => {
    const [w1, w2] = pair({}, makeStore())
    const page = await openPage(w1.handler)
    let answered = false
    const second = postEvent(w1.handler, page, increment(2)).then(response => {
      answered = true
      return response
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.isFalse(answered, 'an event behind a gap is not answered yet')
    await postEvent(w1.handler, page, increment(1))
    assert.strictEqual((await second).status, 204)
    assert.strictEqual(await countOn(w2.handler, page), 2)
  })

  it('applies the late retry of a skipped event on the process that takes over', async () => {
    const [w1, w2] = pair({}, makeStore())
    const page = await openPage(w1.handler)
    // 1 is lost on its way; 2 waits for it, the gap is skipped (1.5 s), 2 is
    // applied and answered.
    assert.strictEqual((await postEvent(w1.handler, page, increment(2))).status, 204)
    // w1 fails; the page's retry of 1 reaches w2, which must not take it for
    // a repeat just because its position (3) is past it.
    assert.strictEqual((await postEvent(w2.handler, page, increment(1))).status, 204)
    assert.strictEqual(await countOn(w2.handler, page), 2)
  })

  it('events arriving together share store writes', async () => {
    const { counter, store } = slowStore(40)
    const [w1, w2] = pair({}, store)
    const page = await openPage(w1.handler)
    const before = counter.writes
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) => postEvent(w1.handler, page, increment(index + 1))),
    )
    assert.deepStrictEqual(new Set(responses.map(response => response.status)), new Set([204]))
    const writes = counter.writes - before
    assert.isAtMost(writes, 5, `20 events took ${writes} writes`)
    assert.strictEqual(await countOn(w2.handler, page), 20)
  })

  it('without durable events, an answered event can be lost (the old behaviour)', async () => {
    const [w1, w2] = pair({ durableEvents: false }, makeStore())
    const page = await openPage(w1.handler)
    assert.strictEqual((await postEvent(w1.handler, page, increment(1))).status, 204)
    // The snapshot follows a quiet second later; w2 starts over from the URL.
    assert.strictEqual(await countOn(w2.handler, page), 0)
  })
})
