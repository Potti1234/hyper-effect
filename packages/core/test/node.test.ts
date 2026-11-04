import { afterAll, assert, describe, it } from '@effect/vitest'

import { nodeOfPath } from '../src/server'
import { makeStore, openPage, postEvent, serve, token, waitForSnapshot } from '../src/testing'

import { program } from './fixtures/greeter'

/* Several processes behind one router: session ids name their node. */

describe('nodes', () => {
  const store = makeStore()
  const w1 = serve({ ...program, name: 'nodes' }, { node: 'w1' }, store)
  const w2 = serve({ ...program, name: 'nodes' }, { node: 'w2' }, store)
  afterAll(() => Promise.all([w1.dispose(), w2.dispose()]))

  it('puts the node into session ids, where a router can read it', async () => {
    const page = await openPage(w1.handler)
    assert.match(page.sessionId, /^w1\.[0-9a-f-]{36}$/)
    assert.strictEqual(nodeOfPath(`/_hyper/nodes/s/${page.sessionId}/stream?u=%2F`), 'w1')
    assert.strictEqual(nodeOfPath(`/_hyper/nodes/s/${page.sessionId}`), 'w1')
    assert.isUndefined(nodeOfPath('/'))
    assert.isUndefined(nodeOfPath(`/_hyper/nodes/s/${crypto.randomUUID()}`))
  })

  it("restores another node's session from the shared store, for failover", async () => {
    const page = await openPage(w1.handler)
    await postEvent(w1.handler, page, { m: token({ _tag: 'ClickedIncrement' }), q: 1 })
    await waitForSnapshot(store, page)
    assert.strictEqual((await postEvent(w2.handler, page, { m: token({ _tag: 'ClickedIncrement' }), q: 2 })).status, 204)
  })

  it('refuses a node name that is not plain', () => {
    assert.throws(() => serve({ ...program, name: 'bad' }, { node: 'W 1' }))
  })
})
