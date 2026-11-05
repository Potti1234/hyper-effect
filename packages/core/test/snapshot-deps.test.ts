import { afterAll, assert, describe, it } from '@effect/vitest'
import { Context, Effect } from 'effect'
import { KeyValueStore } from 'effect/persistence'

import { makeStore, openPage, postEvent, serve, token, waitForSnapshot } from '../src/testing'

import { program } from './fixtures/greeter'

/* Snapshots only for a session's own state (Program.snapshotDeps). */

describe('snapshot deps', () => {
  const store = makeStore()
  const raw = Context.get(store, KeyValueStore.KeyValueStore)
  // The clock Subscription changes `serverTime` every second; it is not the
  // session's own state, so it must not cause snapshots.
  const server = serve(
    { ...program, name: 'snapdeps', snapshotDeps: model => [model.count, model.name, model.greetings] },
    {},
    store,
  )
  afterAll(() => server.dispose())

  const snapshotOf = (sessionId: string) => Effect.runPromise(raw.get(`hyper/snapdeps/${sessionId}`))

  it('writes no snapshot for changes outside the deps, and one for changes inside', async () => {
    const page = await openPage(server.handler)
    await waitForSnapshot(store, page)
    const first = await snapshotOf(page.sessionId)
    await new Promise(resolve => setTimeout(resolve, 2500)) // two clock ticks, at least
    assert.strictEqual(await snapshotOf(page.sessionId), first)

    // The answer comes once the snapshot is written (durable events).
    await postEvent(server.handler, page, { m: token({ _tag: 'ClickedIncrement' }), q: 1 })
    const after = JSON.parse((await snapshotOf(page.sessionId)) ?? '{}')
    assert.strictEqual(after.model.count, 1)
    assert.strictEqual(after.position, 2)
  })
})
