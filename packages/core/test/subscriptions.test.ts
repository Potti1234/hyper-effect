import { assert, describe, it } from '@effect/vitest'
import { Effect, Option, Schema as S, Stream, SubscriptionRef } from 'effect'
import { Subscription } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'

import type { Program } from '../src/program'
import * as Session from '../src/session'

/* Subscriptions start, stop and restart with their dependencies. */

const Model = S.Struct({ on: S.Boolean, ticks: S.Number, label: S.String })
type Model = typeof Model.Type
const Message = defineMessageUnion({ Toggled: {}, Ticked: {}, Relabeled: { label: S.String } })
type Message = typeof Message.Type

const program: Program<Model, Message, Message> = {
  name: 'subs',
  Model,
  ClientMessage: Message,
  flags: () => Effect.void,
  init: () => ({ model: { on: false, ticks: 0, label: '' } }),
  update: (model, message) => {
    switch (message._tag) {
      case 'Toggled':
        return { model: { ...model, on: !model.on } }
      case 'Ticked':
        return { model: { ...model, ticks: model.ticks + 1 } }
      case 'Relabeled':
        return { model: { ...model, label: message.label } }
    }
  },
  view: (_, h) => ({ title: 'subs', body: h.div([], []) }),
  subscriptions: Subscription.make<Model, Message>()(entry => ({
    ticker: entry(
      { on: S.Boolean },
      {
        modelToDependencies: model => ({ on: model.on }),
        dependenciesToStream: ({ on }) =>
          on ? Stream.tick('20 millis').pipe(Stream.map(() => Message.Ticked())) : Stream.empty,
      },
    ),
  })),
}

const settle = (session: Session.Session<Model, Message>, predicate: (model: Model) => boolean) =>
  SubscriptionRef.changes(session.model).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.timeout('3 seconds'),
  )

describe('subscriptions', () => {
  it.live('start, stop and restart with their dependencies, not with other changes', () =>
    Effect.gen(function* () {
      const session = yield* Session.make(program, 'subs', { model: program.init().model, firstSequence: 1 })
      yield* Effect.sleep('100 millis')
      assert.strictEqual((yield* SubscriptionRef.get(session.model)).ticks, 0)

      yield* session.dispatch(Message.Toggled())
      yield* settle(session, model => model.ticks >= 3)

      // A change outside the dependencies does not restart the ticker.
      yield* session.dispatch(Message.Relabeled({ label: 'x' }))
      const ticking = yield* settle(session, model => model.label === 'x')
      yield* settle(session, model => model.ticks >= ticking.ticks + 2)

      yield* session.dispatch(Message.Toggled())
      const stopped = yield* settle(session, model => !model.on)
      yield* Effect.sleep('150 millis')
      assert.isAtMost((yield* SubscriptionRef.get(session.model)).ticks, stopped.ticks + 1)
      yield* session.close
    }),
  )
})
