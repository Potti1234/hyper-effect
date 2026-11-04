import { afterAll, assert, describe, it } from '@effect/vitest'
import { Effect, Schema as S } from 'effect'
import { Command } from 'foldkit'

import { openPage, openStream, postEvent, readUntil, serve, token } from '../src/testing'

import { init, Message, program } from './fixtures/greeter'

/* Speculation-rules prefetch: a prefetched page starts no session; following
   the link starts it from the URL when its stream opens. */

const prefetch = { 'sec-purpose': 'prefetch' }

describe('prefetch', () => {
  const server = serve({ ...program, name: 'prefetched' }, { prefetch: ['/issue/*'] })
  afterAll(() => server.dispose())

  it('lists the prefetch patterns as speculation rules', async () => {
    const page = await openPage(server.handler)
    assert.include(
      page.html,
      '{"prefetch":[{"where":{"href_matches":["/issue/*"]},"eagerness":"moderate"}]}</script>',
    )
    assert.match(page.html, /<script type="speculationrules" nonce="[^"]+">/)
  })

  it('renders a prefetch without holding a session, and starts it when followed', async () => {
    const first = await openPage(server.handler)
    const response = await server.handler(
      new Request('http://localhost/', { headers: { cookie: first.cookie, ...prefetch } }),
    )
    assert.strictEqual(response.status, 200)
    const html = await response.text()
    const sessionId = html.match(/\/_hyper\/prefetched\/s\/([0-9a-z.-]+)\/stream/)?.[1] ?? ''
    assert.notStrictEqual(sessionId, '')
    assert.include(html, 'hyper-effect (0)')
    const prefetched = { program: 'prefetched', sessionId, cookie: first.cookie }
    // Nothing holds it: an event before the stream opens finds no session.
    assert.strictEqual(
      (await postEvent(server.handler, prefetched, { m: token({ _tag: 'ClickedIncrement' }), q: 1 })).status,
      410,
    )
    // The followed link opens the stream, which starts the session from the URL.
    const stream = await openStream(server.handler, prefetched)
    assert.strictEqual(stream.status, 200)
    assert.include(await readUntil(stream, '</title>'), 'hyper-effect (0)')
    assert.strictEqual(
      (await postEvent(server.handler, prefetched, { m: token({ _tag: 'ClickedIncrement' }), q: 1 })).status,
      204,
    )
  })
})

describe('prefetch with init Commands', () => {
  let initRuns = 0
  const CountInitRun = Command.define('CountInitRun', {
    args: { reason: S.String },
    messages: [Message.ClickedIncrement],
    execute: () =>
      Effect.sync(() => {
        initRuns += 1
        return Message.ClickedIncrement()
      }),
  })
  const server = serve(
    {
      ...program,
      name: 'prefetched-init',
      init: () => ({ ...init(), commands: [CountInitRun({ reason: 'init' })] }),
    },
    { prefetch: ['/issue/*'] },
  )
  afterAll(() => server.dispose())

  it('runs init Commands only once the followed page opens its stream', async () => {
    const first = await openPage(server.handler)
    // The opened page's own init Command runs in the background.
    await Effect.runPromise(Effect.sleep('100 millis'))
    const before = initRuns
    const response = await server.handler(
      new Request('http://localhost/', { headers: { cookie: first.cookie, ...prefetch } }),
    )
    const sessionId = (await response.text()).match(/\/_hyper\/prefetched-init\/s\/([0-9a-z.-]+)\/stream/)?.[1] ?? ''
    assert.notStrictEqual(sessionId, '')
    await Effect.runPromise(Effect.sleep('100 millis'))
    assert.strictEqual(initRuns, before)
    const stream = await openStream(server.handler, { program: 'prefetched-init', sessionId, cookie: first.cookie })
    assert.strictEqual(stream.status, 200)
    assert.include(await readUntil(stream, 'hyper-effect (1)'), 'hyper-effect (1)')
    assert.strictEqual(initRuns, before + 1)
  })
})
