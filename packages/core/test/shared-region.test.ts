import { afterAll, assert, beforeAll, describe, it } from '@effect/vitest'
import { Effect, Exit, Schema as S } from 'effect'
import { defineMessageUnion } from 'foldkit/message'

import type { Program } from '../src/program'
import { region, sharedRegionCache, sharedRegionStats } from '../src/region'
import * as Session from '../src/session'

/* Regions rendered once for every session (`shared: true`). */

const Message = defineMessageUnion({ ClickedRow: { id: S.String }, Typed: { text: S.String } })
type Message = typeof Message.Type

let renders = 0

const rows: Program<ReadonlyArray<string>, Message, Message> = {
  name: 'shared-region',
  Model: S.Array(S.String),
  ClientMessage: Message,
  flags: () => Effect.void,
  init: () => ({ model: ['a', 'b'] }),
  update: model => ({ model }),
  view: (model, h) => ({
    title: 'rows',
    body: h.ul(
      [],
      model.map(id =>
        region(h, {
          id: `row-${id}`,
          deps: [id],
          shared: true,
          render: () => {
            renders += 1
            return h.li([h.Id(`row-${id}`), h.OnClick(Message.ClickedRow({ id }))], [id])
          },
        }),
      ),
    ),
  }),
}

describe('shared regions', () => {
  beforeAll(() => {
    sharedRegionCache.enabled = true
  })
  afterAll(() => {
    sharedRegionCache.enabled = false
  })

  it.effect('render once per deps for all sessions of a program', () =>
    Effect.gen(function* () {
      renders = 0
      const before = sharedRegionStats().hits
      const sessions = yield* Effect.all(
        Array.from({ length: 5 }, (_, index) => Session.make(rows, `s${index}`, { model: ['a', 'b'], firstSequence: 1 })),
      )
      const rendered = yield* Effect.all(sessions.map(session => session.render))
      assert.strictEqual(renders, 2)
      assert.strictEqual(sharedRegionStats().hits - before, 8)
      // Same markup everywhere, bound by Message tokens only.
      assert.include(rendered[4]?.regions.get('row-a')?.html ?? '', "m: '")
      yield* Effect.all(sessions.map(session => session.close))
    }),
  )

  it.effect('refuse function handlers, which belong to one session', () =>
    Effect.gen(function* () {
      const typing: Program<ReadonlyArray<string>, Message, Message> = {
        ...rows,
        name: 'shared-region-input',
        view: (_, h) => ({
          title: 'input',
          body: region(h, {
            id: 'field',
            deps: [],
            shared: true,
            render: () => h.input([h.Id('field'), h.OnInput(text => Message.Typed({ text }))]),
          }),
        }),
      }
      const session = yield* Session.make(typing, 'x', { model: [], firstSequence: 1 })
      assert.isTrue(Exit.isFailure(yield* Effect.exit(session.render)))
      yield* session.close
    }),
  )
})

describe('shared regions, development check', () => {
  it.effect('fail when two sessions render different markup under the same deps', () =>
    Effect.gen(function* () {
      // The greeting reads the session's user, which its deps miss: shared,
      // Ada's name would reach Bob.
      const greeting: Program<string, Message, Message> = {
        name: 'shared-region-leak',
        Model: S.String,
        ClientMessage: Message,
        flags: () => Effect.void,
        init: () => ({ model: '' }),
        update: model => ({ model }),
        view: (user, h) => ({
          title: 'greeting',
          body: region(h, {
            id: 'greeting',
            deps: [],
            shared: true,
            render: () => h.p([h.Id('greeting')], [`Hello, ${user}`]),
          }),
        }),
      }
      const ada = yield* Session.make(greeting, 'ada', { model: 'Ada', firstSequence: 1 })
      const bob = yield* Session.make(greeting, 'bob', { model: 'Bob', firstSequence: 1 })
      assert.isTrue(Exit.isSuccess(yield* Effect.exit(ada.render)))
      const leaked = yield* Effect.exit(bob.render)
      assert.isTrue(Exit.isFailure(leaked))
      assert.include(String(Exit.isFailure(leaked) ? leaked.cause : ''), 'renders differently with the same deps')
      yield* ada.close
      yield* bob.close
    }),
  )
})
