import { afterAll, assert, describe, it } from '@effect/vitest'
import { Context, Effect, Exit, Layer, Scope } from 'effect'
import { HttpRouter, HttpServer, HttpServerResponse } from 'effect/http'

import { PageHost, pageHost } from '../src/page-host'
import type { Program } from '../src/program'
import { DATASTAR_PATH } from '../src/server'
import { makeStore, openPage, openStream, readUntil } from '../src/testing'

import * as Greeter from './fixtures/greeter'

/* Pages mounted and unmounted while the server runs, through the page host. */

const store = makeStore()
let host: Context.Context<PageHost> | undefined

const server = HttpRouter.toWebHandler(
  Layer.mergeAll(
    // Capture the host, as an extension system would get it. Only the
    // service: the layer's context also holds the layer's own Scope.
    Layer.effectDiscard(
      Effect.map(PageHost, service => {
        host = Context.make(PageHost, service)
      }),
    ).pipe(Layer.provide(pageHost)),
    HttpRouter.add('GET', '/own', HttpServerResponse.text('the app')),
  ).pipe(Layer.provide(HttpServer.layerServices), Layer.provide(Layer.succeedContext(store))),
)
afterAll(() => server.dispose())

const get = (path: string) => server.handler(new Request(`http://localhost${path}`))

/** Mounts `program` in a new scope and returns a function that closes it. */
const mount = async <M, Msg, C extends Msg, F>(program: Program<M, Msg, C, F>, path: string) => {
  // The host exists once the handler has built its layer, on the first request.
  if (host === undefined) await get('/own')
  const scope = Effect.runSync(Scope.make())
  await Effect.runPromise(
    Effect.flatMap(PageHost, page => page.mount(program, { path })).pipe(
      Effect.provide(host!),
      Effect.provide(store),
      Scope.provide(scope),
    ),
  )
  return () => Effect.runPromise(Scope.close(scope, Exit.void))
}

const titled = (title: string): Program<Greeter.Model, Greeter.Message, Greeter.ClientMessage> => ({
  ...Greeter.program,
  view: (model, h) => ({ ...Greeter.program.view(model, h), title }),
})

describe('page host', () => {
  it('serves the app’s own routes first and 404 for paths nobody serves', async () => {
    assert.strictEqual(await (await get('/own')).text(), 'the app')
    assert.strictEqual((await get('/nothing')).status, 404)
    assert.strictEqual((await get(DATASTAR_PATH)).status, 200)
  })

  it('serves a page while it is mounted, and mounts it again after it closed', async () => {
    const close = await mount({ ...Greeter.program, name: 'again' }, '/again')
    const page = await openPage(server.handler, '/again')
    assert.strictEqual(page.response.status, 200)
    assert.strictEqual(page.program, 'again')
    await close()
    assert.strictEqual((await get('/again')).status, 404)

    // A router of the app would throw here: the same routes are added twice.
    const closeAgain = await mount({ ...Greeter.program, name: 'again' }, '/again')
    assert.strictEqual((await get('/again')).status, 200)
    await closeAgain()
  })

  it('lets a newer page of the same name shadow the older one until it closes', async () => {
    const closeOld = await mount({ ...titled('old'), name: 'swap' }, '/swap')
    const closeNew = await mount({ ...titled('new'), name: 'swap' }, '/swap')
    assert.include((await openPage(server.handler, '/swap')).html, '>new</title>')
    await closeNew()
    assert.include((await openPage(server.handler, '/swap')).html, '>old</title>')
    await closeOld()
    assert.strictEqual((await get('/swap')).status, 404)
  })

  it('restores an open session under the newer page after the older one closes', async () => {
    const closeOld = await mount({ ...titled('first version'), name: 'restore' }, '/restore')
    const page = await openPage(server.handler, '/restore')
    const before = await openStream(server.handler, page)
    const reader = before.body!.getReader()
    const decoder = new TextDecoder()
    let first = ''
    while (!first.includes('first version')) {
      const { value, done } = await reader.read()
      if (done) break
      first += decoder.decode(value, { stream: true })
    }
    assert.include(first, 'first version')
    const closeNew = await mount({ ...titled('second version'), name: 'restore' }, '/restore')
    await closeOld()
    // The open stream breaks, so Datastar reconnects (it does not reopen a
    // stream that ends normally).
    const ending = async (): Promise<string> => {
      try {
        while (!(await reader.read()).done);
        return 'ended'
      } catch {
        return 'broke'
      }
    }
    assert.strictEqual(await ending(), 'broke')
    // The browser reconnects its stream; the new page restores the session.
    const stream = await openStream(server.handler, page)
    assert.strictEqual(stream.status, 200)
    assert.include(await readUntil(stream, 'second version'), 'second version')
    await closeNew()
  })

  it('refuses a page whose path another mounted page serves', async () => {
    const close = await mount({ ...Greeter.program, name: 'owner' }, '/taken')
    const error = await Effect.runPromise(
      Effect.flatMap(PageHost, page =>
        page.mount({ ...Greeter.program, name: 'intruder' }, { path: '/taken' }),
      ).pipe(Effect.flip, Effect.provide(host!), Effect.provide(store), Effect.scoped),
    )
    assert.strictEqual(error._tag, 'PageConflict')
    assert.strictEqual(error.page, 'intruder')
    // The page mounted first is still served.
    assert.strictEqual((await openPage(server.handler, '/taken')).program, 'owner')
    await close()
  })

  it('lists the pages it serves', async () => {
    const close = await mount({ ...Greeter.program, name: 'listed' }, '/listed')
    const names = await Effect.runPromise(
      Effect.flatMap(PageHost, page => page.names).pipe(Effect.provide(host!)),
    )
    assert.deepStrictEqual(names, ['listed'])
    await close()
  })
})
