import { afterAll, assert, describe, it } from '@effect/vitest'

import { makeStore, openPage, openStream, postEvent, readUntil, serve, token, waitForSnapshot } from '../src/testing'

import { program } from './fixtures/greeter'

/* Experiment 5 over HTTP: retries and restarts never apply an event twice. */

const increment = (q: number) => ({ m: token({ _tag: 'ClickedIncrement' }), q })

const titleOf = async (handler: Parameters<typeof openStream>[0], page: Parameters<typeof openStream>[1]) => {
  const text = await readUntil(await openStream(handler, page), '</title>')
  return text.match(/hyper-effect \((\d+)\)/)?.[1]
}

describe('delivery', () => {
  const store = makeStore()
  const server = serve({ ...program, name: 'delivery' }, {}, store)
  afterAll(() => server.dispose())

  it('applies a retried event once', async () => {
    const page = await openPage(server.handler)
    for (const q of [1, 1, 2, 2, 1]) {
      assert.strictEqual((await postEvent(server.handler, page, increment(q))).status, 204)
    }
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.strictEqual(await titleOf(server.handler, page), '2')
  })

  it('continues from the snapshot after a restart: retries are dropped, new events applied', async () => {
    const page = await openPage(server.handler)
    await postEvent(server.handler, page, increment(1))
    await postEvent(server.handler, page, increment(2))
    await waitForSnapshot(store, page)
    const restarted = serve({ ...program, name: 'delivery' }, {}, store)
    try {
      // The browser retries event 2 (its answer was lost in the restart),
      // then sends event 3.
      await postEvent(restarted.handler, page, increment(2))
      await postEvent(restarted.handler, page, increment(3))
      await new Promise(resolve => setTimeout(resolve, 100))
      assert.strictEqual(await titleOf(restarted.handler, page), '3')
    } finally {
      await restarted.dispose()
    }
  })
})
