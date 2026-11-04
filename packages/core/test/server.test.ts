import { afterAll, assert, describe, it } from '@effect/vitest'
import { Effect, Schema as S } from 'effect'

import { PageNotFound, type Program } from '../src/program'

import { program } from './fixtures/greeter'

import {
  makeStore,
  openPage,
  openStream,
  postEvent,
  readUntil,
  serve,
  token,
  waitForSnapshot,
} from '../src/testing'

/** One shared store, so a second handler can play "the server after a
 *  restart" (or another node). */
const store = makeStore()
const first = serve(program, {}, store)
afterAll(() => first.dispose())

describe('http', () => {
  it('serves a complete page that works without JavaScript', async () => {
    const { response, html, sessionId, cookie } = await openPage(first.handler)
    assert.strictEqual(response.status, 200)
    assert.include(response.headers.get('content-type') ?? '', 'text/html')
    assert.include(html, '<title id="hyper-title">hyper-effect (0)</title>')
    assert.include(html, 'data-signals:_hq="0"')
    assert.include(html, 'datastar-fetch')
    assert.include(html, 'Save greeting')
    assert.isNotEmpty(sessionId)
    assert.match(cookie, /^hyper-visitor=[0-9a-f-]{36}$/)
  })

  it('applies posted events and streams the morph', async () => {
    const page = await openPage(first.handler)
    const post = await postEvent(first.handler, page, {
      m: token({ _tag: 'ClickedIncrement' }),
      q: 1,
    })
    assert.strictEqual(post.status, 204)

    const stream = await openStream(first.handler, page)
    assert.include(stream.headers.get('content-type') ?? '', 'text/event-stream')
    const events = await readUntil(stream, '\n\n')
    assert.include(events, 'event: datastar-patch-elements')
    assert.include(events, 'data: elements <title id="hyper-title">hyper-effect (1)</title>')
    assert.include(events, 'data: elements <div id="hyper-root"')
  })

  it('rejects malformed events and unknown sessions', async () => {
    const page = await openPage(first.handler)
    const malformed = await postEvent(first.handler, page, { nonsense: true })
    assert.strictEqual(malformed.status, 400)

    const unknown = await postEvent(
      first.handler,
      { ...page, sessionId: crypto.randomUUID() },
      { m: token({ _tag: 'ClickedIncrement' }) },
    )
    assert.strictEqual(unknown.status, 410)
  })

  it('restores a session from its snapshot after a restart', async () => {
    const page = await openPage(first.handler)
    await postEvent(first.handler, page, { m: token({ _tag: 'ClickedIncrement' }), q: 1 })
    await postEvent(first.handler, page, { m: token({ _tag: 'ClickedIncrement' }), q: 2 })
    await waitForSnapshot(store, page)

    // A new server instance (or another node) sharing the store.
    const restarted = serve(program, {}, store)
    try {
      const post = await postEvent(restarted.handler, page, {
        m: token({ _tag: 'ClickedIncrement' }),
        q: 3,
      })
      assert.strictEqual(post.status, 204)
      const events = await readUntil(await openStream(restarted.handler, page), 'hyper-effect (3)')
      assert.include(events, 'hyper-effect (3)')
    } finally {
      await restarted.dispose()
    }
  })

  it('answers 404 when Flags fail with PageNotFound', async () => {
    const items: Program<{ id: string }, never, never, string> = {
      name: 'item',
      Model: S.Struct({ id: S.String }),
      ClientMessage: S.Never,
      flags: ({ params }) =>
        params['id'] === 'known'
          ? Effect.succeed(params['id'])
          : Effect.fail(new PageNotFound()),
      init: id => ({ model: { id } }),
      update: model => ({ model }),
      view: (model, h) => ({ title: model.id, body: h.p([], [`Item ${model.id}`]) }),
    }
    const served = serve(items, { path: '/items/:id' })
    try {
      const found = await openPage(served.handler, '/items/known')
      assert.strictEqual(found.response.status, 200)
      assert.include(found.html, 'Item known')
      const missing = await served.handler(new Request('http://localhost/items/other'))
      assert.strictEqual(missing.status, 404)
    } finally {
      await served.dispose()
    }
  })
})
