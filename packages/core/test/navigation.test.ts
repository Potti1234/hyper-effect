import { afterAll, assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'

import { PageNotFound, PageRedirect, type Program } from '../src/program'
import { openPage, openStream, readUntil, serve, type Page } from '../src/testing'

import { Message, program as greeter, type ClientMessage, type Model } from './fixtures/greeter'

/* Navigation within a session: `paths` plus `onUrlChange`. */

const program: Program<Model, Message, ClientMessage> = {
  ...greeter,
  name: 'navigating',
  onUrlChange: request => {
    const name = request.params['name'] ?? ''
    if (name === 'missing') return Effect.fail(new PageNotFound())
    if (name === 'elsewhere') return Effect.fail(new PageRedirect({ location: '/login' }))
    return Effect.succeed(Message.ChangedName({ name }))
  },
}

type Handler = Parameters<typeof openStream>[0]

const navigate = (handler: Handler, page: Page, u: string) =>
  handler(
    new Request(`http://localhost/_hyper/${page.program}/s/${page.sessionId}/nav`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'datastar-request': 'true', cookie: page.cookie },
      body: JSON.stringify({ u }),
    }),
  )

describe('navigation within a session', () => {
  const server = serve(program, { paths: ['/hello/:name'] })
  const plain = serve({ ...greeter, name: 'plain' }, { paths: ['/hello/:name'] })
  afterAll(() => Promise.all([server.dispose(), plain.dispose()]))

  it('serves every pattern as a page and lists them for the page script', async () => {
    const page = await openPage(server.handler, '/hello/bob')
    assert.strictEqual(page.response.status, 200)
    assert.include(page.html, 'data-hyper-paths="[&quot;/&quot;,&quot;/hello/:name&quot;]"')
  })

  it('turns a URL of the program into a Message of the same session', async () => {
    const page = await openPage(server.handler)
    const stream = await openStream(server.handler, page)
    assert.strictEqual((await navigate(server.handler, page, '/hello/ada')).status, 204)
    assert.include(await readUntil(stream, 'ada'), 'ada')
  })

  it('loads a page for URLs the session does not take', async () => {
    const page = await openPage(server.handler)
    const loads = async (u: string) => {
      const response = await navigate(server.handler, page, u)
      return response.status === 200 ? ((await response.json()) as { load: string }).load : response.status
    }
    assert.strictEqual(await loads('/hello/missing'), '/hello/missing')
    assert.strictEqual(await loads('/hello/elsewhere'), '/login')
    assert.strictEqual(await loads('/other/place'), '/other/place')
    assert.strictEqual(await loads('https://evil.example/hello/x'), 400)
    assert.strictEqual(await loads('//evil.example/hello/x'), 400)
  })

  it('without onUrlChange every URL is a page load', async () => {
    const page = await openPage(plain.handler)
    assert.notInclude(page.html, 'data-hyper-paths="')
    const response = await navigate(plain.handler, page, '/hello/ada')
    assert.deepStrictEqual(await response.json(), { load: '/hello/ada' })
  })
})
