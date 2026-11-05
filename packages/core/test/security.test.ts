import { afterAll, assert, describe, it } from '@effect/vitest'
import { Effect, Schema as S } from 'effect'
import type { HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { type DefaultTreeAdapterMap, parseFragment } from 'parse5'

import * as Metrics from '../src/metrics'
import type { Program } from '../src/program'
import { renderModel } from '../src/session'
import { makeStore, openPage, openStream, postEvent, serve, token, waitForSnapshot } from '../src/testing'

import * as Greeter from './fixtures/greeter'

/* Experiment 2: every attack here must be refused. */

const secured: typeof Greeter.program = { ...Greeter.program, name: 'secure' }
const store = makeStore()
const server = serve(secured, { limits: { sessionsPerVisitor: 4 } }, store)
afterAll(() => server.dispose())

const increment = (q: number) => ({ m: token({ _tag: 'ClickedIncrement' }), q })

describe('session ownership', () => {
  it('refuses events and streams from another browser', async () => {
    const victim = await openPage(server.handler)
    const attacker = await openPage(server.handler)
    const forged = { ...victim, cookie: attacker.cookie }
    assert.strictEqual((await postEvent(server.handler, forged, increment(1))).status, 403)
    assert.strictEqual((await openStream(server.handler, forged)).status, 403)
    // The owner is unaffected.
    assert.strictEqual((await postEvent(server.handler, victim, increment(1))).status, 204)
  })

  it('refuses session requests without the visitor cookie', async () => {
    const page = await openPage(server.handler)
    const anonymous = { ...page, cookie: '' }
    assert.strictEqual((await postEvent(server.handler, anonymous, increment(1))).status, 403)
    assert.strictEqual((await openStream(server.handler, anonymous)).status, 403)
  })

  it("never restores another visitor's snapshot", async () => {
    const victim = await openPage(server.handler)
    await postEvent(server.handler, victim, increment(1))
    await waitForSnapshot(store, victim)
    const restarted = serve(secured, {}, store)
    try {
      const attacker = await openPage(restarted.handler)
      const forged = { ...victim, cookie: attacker.cookie }
      assert.strictEqual((await postEvent(restarted.handler, forged, increment(2))).status, 410)
      assert.strictEqual((await openStream(restarted.handler, forged)).status, 403)
      // The victim still gets their session back.
      assert.strictEqual((await postEvent(restarted.handler, victim, increment(2))).status, 204)
    } finally {
      await restarted.dispose()
    }
  })
})

describe('cross-site requests', () => {
  it('refuses posts from another origin', async () => {
    const page = await openPage(server.handler)
    const response = await postEvent(server.handler, page, increment(1), {
      origin: 'https://evil.example',
    })
    assert.strictEqual(response.status, 403)
  })

  it('refuses requests Datastar did not send', async () => {
    const page = await openPage(server.handler)
    assert.strictEqual(
      (await postEvent(server.handler, page, increment(1), { 'datastar-request': 'false' })).status,
      403,
    )
    assert.strictEqual(
      (await openStream(server.handler, page, { 'datastar-request': 'false' })).status,
      403,
    )
  })
})

describe('resource limits', () => {
  it('refuses oversized bodies and too many pending inputs', async () => {
    const page = await openPage(server.handler)
    const huge = JSON.stringify({ ...increment(1), padding: 'x'.repeat(64 * 1024) })
    const oversized = await postEvent(server.handler, page, huge, {
      'content-length': String(huge.length),
    })
    assert.include([400, 413], oversized.status)
    const manyInputs = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`a.${i}`, 'x']))
    const flooded = await postEvent(server.handler, page, { ...increment(1), p: manyInputs })
    assert.strictEqual(flooded.status, 400)
  })

  it('rate-limits an event flood per session', async () => {
    const page = await openPage(server.handler)
    const statuses = await Promise.all(
      Array.from({ length: 100 }, (_, i) => postEvent(server.handler, page, increment(i + 1))),
    ).then(responses => responses.map(response => response.status))
    assert.isAbove(statuses.filter(status => status === 429).length, 0)
    assert.isAbove(statuses.filter(status => status === 204).length, 0)
  })

  it('rejects malformed session ids before any lookup or store access', async () => {
    const page = await openPage(server.handler)
    for (const sessionId of ['..', '..%2F..%2Fsecrets', 'not-a-uuid', 'x'.repeat(300)]) {
      // 400 from the id check, or 404 when URL normalization already routes
      // it elsewhere: either way it never reaches a lookup.
      const response = await postEvent(server.handler, { ...page, sessionId }, increment(1))
      assert.include([400, 404], response.status, sessionId)
      const stream = await openStream(server.handler, { ...page, sessionId })
      assert.include([400, 404], stream.status, sessionId)
    }
  })

  it('caps sessions per visitor, closing their oldest', async () => {
    const first = await openPage(server.handler)
    for (let index = 0; index < 6; index += 1) {
      await openPage(server.handler, '/', first.cookie)
    }
    const counts = Metrics.snapshot().programs['secure']
    assert.isDefined(counts)
    // The first page was the oldest of this visitor and has been closed.
    assert.strictEqual((await postEvent(server.handler, first, increment(1))).status, 410)
  })
})

describe('markup injection', () => {
  const hostile = `"><script>alert(1)</script><img src=x onerror=alert(2)> $evil @post('/x') {{x}}`

  const Message = defineMessageUnion({ ClickedLabel: { label: S.String } })
  type Message = typeof Message.Type

  const echo: Program<string, Message, Message> = {
    name: 'echo',
    Model: S.String,
    ClientMessage: Message,
    flags: () => Effect.void,
    init: () => ({ model: hostile }),
    update: model => ({ model }),
    view: (model, h: HtmlBuilder<Message>) => ({
      title: model,
      body: h.div(
        [h.Title(model), h.DataAttribute('label', model)],
        [
          h.p([], [model]),
          h.button([h.OnClick(Message.ClickedLabel({ label: model }))], [model]),
          h.input([h.Id('field'), h.Value(model), h.OnInput(label => Message.ClickedLabel({ label }))]),
        ],
      ),
    }),
  }

  it('escapes user content everywhere and keeps it out of Datastar expressions', () =>
    Effect.gen(function* () {
      const binder = {
        endpoint: '/x',
        bindMessage: (message: Message) => `m: '${token(S.encodeUnknownSync(Message)(message))}'`,
        registerHandler: () => 'a.0',
        registerInput: () => {},
      }
      for (const validate of [true, false]) {
        const { html } = yield* renderModel(echo, hostile, binder, { validate })
        // Parse the output the way a browser would: the hostile text must
        // only ever be text or an attribute value.
        const elements: Array<string> = []
        const handlers: Array<string> = []
        const walk = (node: DefaultTreeAdapterMap['node']) => {
          if ('tagName' in node) {
            elements.push(node.tagName)
            for (const { name } of node.attrs) if (name.startsWith('on')) handlers.push(name)
          }
          if ('childNodes' in node) node.childNodes.forEach(walk)
        }
        walk(parseFragment(html))
        assert.notInclude(elements, 'script')
        assert.notInclude(elements, 'img')
        assert.deepStrictEqual(handlers, [])
        // Every Datastar expression is built from tokens, ids and constants only.
        const expressions = [...html.matchAll(/data-on:[^=]+="([^"]*)"/g)].map(match => match[1] ?? '')
        assert.isNotEmpty(expressions)
        for (const expression of expressions) {
          assert.notInclude(expression, 'evil')
          assert.notInclude(expression, 'alert')
        }
      }
    }).pipe(Effect.runPromise))
})

describe('Datastar plugin collisions', () => {
  // Attributes Datastar evaluates as code; only the ones hyper-effect emits
  // may appear in rendered pages.
  const PLUGINS = [
    'attr', 'bind', 'class', 'computed', 'effect', 'ignore', 'ignore-morph', 'indicator', 'init',
    'json-signals', 'on', 'on-intersect', 'on-interval', 'on-signal-patch', 'on-signal-patch-filter',
    'preserve-attr', 'ref', 'show', 'signals', 'style', 'text', 'animate', 'custom-validity',
    'match-media', 'on-raf', 'on-resize', 'persist', 'query-string', 'replace-url',
    'scroll-into-view', 'view-transition',
  ]
  const EMITTED = new Set(['on', 'bind', 'preserve-attr', 'ignore-morph'])

  it('rendered pages use no Datastar attribute hyper-effect did not emit', () =>
    Effect.gen(function* () {
      const binder = {
        endpoint: '/x',
        bindMessage: (message: unknown) => `m: '${token(message)}'`,
        registerHandler: () => 'a.0',
        registerInput: () => {},
      }
      const pages = [renderModel(Greeter.program, Greeter.program.init().model, binder as never)]
      const collisions = new Set<string>()
      for (const render of pages) {
        const { html } = yield* render
        for (const [, name] of html.matchAll(/\sdata-([a-z0-9-]+)[:=\s>_]/g)) {
          const base = (name ?? '').replace(/__.*$/, '')
          if (PLUGINS.includes(base) && !EMITTED.has(base)) collisions.add(base)
        }
      }
      assert.deepStrictEqual([...collisions], [])
    }).pipe(Effect.runPromise))
})
