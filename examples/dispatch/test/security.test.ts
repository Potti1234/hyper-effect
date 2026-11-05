import { assert, describe, it } from '@effect/vitest'
import { Effect, Schema as S } from 'effect'
import type { HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { type DefaultTreeAdapterMap, parseFragment } from 'parse5'

import type { Program } from '@hyper-effect/core'
import { renderModel, token } from '@hyper-effect/core/testing'
import * as Island from '@hyper-effect/island'

import * as Board from '@/app/dispatch/board'
import * as Incident from '@/app/dispatch/incident'
import { IncidentMap } from '@/app/dispatch/islands/incident-map'
import * as Greeter from '@/app/greeter'

/* The app-level half of experiment 2: island props and every Dispatch page.
   The HTTP attacks live in packages/core/test/security.test.ts. */

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
          Island.view(
            IncidentMap,
            {
              id: 'map',
              props: {
                markers: [
                  { id: model, title: model, severity: 'low', status: 'open', longitude: 0, latitude: 0 },
                ],
                selectedId: null,
                draft: null,
                mode: 'view',
              },
              onEvent: () => Message.ClickedLabel({ label: '' }),
            },
            h,
          ),
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
      const incident = {
        id: 'INC-1', title: 'T', severity: 'high' as const, status: 'open' as const,
        location: { longitude: 0, latitude: 0 }, assignee: null, createdAt: 0, comments: [],
      }
      const pages = [
        renderModel(Greeter.program, Greeter.program.init().model, binder as never),
        renderModel(
          Board.program,
          Board.init({ me: 'A', version: 'scan.1', incidents: [incident], activity: [] }).model,
          binder as never,
        ),
        renderModel(Incident.program, Incident.init({ me: 'A', incident }).model, binder as never),
      ]
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
