import { assert, describe, it } from '@effect/vitest'
import { Effect, Fiber, Option, Schema as S, Stream, SubscriptionRef } from 'effect'
import { defineMessageUnion } from 'foldkit/message'

import type { Program } from '../src/program'

import * as Session from '../src/session'

import { Message, type Model, program } from './fixtures/greeter'

const token = (value: unknown) =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')

const fresh = (id = 'test') =>
  Session.make(program, id, { model: program.init().model, firstSequence: 1 })

const waitFor = (
  session: Session.Session<Model, Message>,
  predicate: (model: Model) => boolean,
) =>
  SubscriptionRef.changes(session.model).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.timeout('3 seconds'),
  )

const handlerIdOf = (html: string) => html.match(/\{h: '([^']+)'/)?.[1] ?? ''

describe('session runtime', () => {
  it.live('folds client Messages through update', () =>
    Effect.gen(function* () {
      const session = yield* fresh()
      yield* session.dispatch(Message.ClickedIncrement())
      yield* session.dispatch(Message.ClickedIncrement())
      const model = yield* waitFor(session, model => model.count === 2)
      assert.strictEqual(model.count, 2)
      yield* session.close
    }),
  )

  it.live('runs Commands and feeds their Messages back', () =>
    Effect.gen(function* () {
      const session = yield* fresh()
      yield* session.dispatch(Message.ChangedName({ name: 'Ada' }))
      yield* session.dispatch(Message.SubmittedGreeting())
      const model = yield* waitFor(session, model => model.greetings.length > 0)
      assert.deepStrictEqual(model.greetings, ['Hello, Ada!'])
      assert.strictEqual(model.saveState._tag, 'Idle')
      yield* session.close
    }),
  )

  it.live('runs Subscriptions', () =>
    Effect.gen(function* () {
      const session = yield* fresh()
      const model = yield* waitFor(session, model => model.serverTime !== '--:--:--')
      assert.match(model.serverTime, /^\d\d:\d\d:\d\d$/)
      yield* session.close
    }),
  )

  it.live('resolves encoded Messages and handler ids from the last render', () =>
    Effect.gen(function* () {
      const session = yield* fresh()
      const { html } = yield* session.render
      assert.deepStrictEqual(
        session.resolve({ m: token({ _tag: 'ClickedIncrement' }) }),
        Option.some(Message.ClickedIncrement()),
      )
      assert.deepStrictEqual(
        session.resolve({ h: handlerIdOf(html), v: 'Grace' }),
        Option.some(Message.ChangedName({ name: 'Grace' })),
      )
      yield* session.close
    }),
  )

  it.live('rejects forged server-only Messages and unknown handlers', () =>
    Effect.gen(function* () {
      const session = yield* fresh()
      const forged = session.resolve({
        m: token({ _tag: 'SucceededSaveGreeting', greeting: 'forged' }),
      })
      assert.isTrue(Option.isNone(forged))
      assert.isTrue(Option.isNone(session.resolve({ h: 'nope', v: 'x' })))
      yield* session.close
    }),
  )
})

describe('event ordering', () => {
  it.live('applies events in sequence order, whatever order they arrive in', () =>
    Effect.gen(function* () {
      const session = yield* fresh()
      const { html } = yield* session.render
      const changedName = handlerIdOf(html)
      // The user typed a name (q 1) and then submitted (q 2); the submit
      // request overtook the name on the network.
      // Receiving completes once the event is applied, so the parked submit
      // is still receiving.
      const submit = yield* Effect.forkChild(
        session.receive({ m: token({ _tag: 'SubmittedGreeting' }), q: 2 }),
      )
      yield* Effect.sleep('50 millis')
      const parked = yield* SubscriptionRef.get(session.model)
      assert.strictEqual(parked.saveState._tag, 'Idle', 'submit waits for its predecessor')
      assert.isUndefined(submit.pollUnsafe(), 'a parked event is not answered')
      yield* session.receive({ h: changedName, v: 'Ada', q: 1 })
      yield* Fiber.join(submit)
      assert.strictEqual(session.applied().position, 3)
      const model = yield* waitFor(session, model => model.greetings.length > 0)
      assert.deepStrictEqual(model.greetings, ['Hello, Ada!'])
      yield* session.close
    }),
  )

  it.live('skips a gap left by a lost request after a timeout', () =>
    Effect.gen(function* () {
      const session = yield* fresh()
      // q 1 never arrives.
      yield* session.receive({ m: token({ _tag: 'ClickedIncrement' }), q: 2 })
      const model = yield* waitFor(session, model => model.count === 1)
      assert.strictEqual(model.count, 1)
      yield* session.close
    }),
  )
})

describe('client-owned inputs', () => {
  it.live('patch the input signal only when the Model diverges from the browser', () =>
    Effect.gen(function* () {
      const session = yield* fresh()
      const first = yield* session.render
      assert.deepStrictEqual(first.signals, {})

      // The browser sends what the user typed: an echo, nothing to patch.
      yield* session.receive({ h: handlerIdOf(first.html), v: 'Ada', q: 1 })
      yield* waitFor(session, model => model.name === 'Ada')
      const echo = yield* session.render
      assert.deepStrictEqual(echo.signals, {})

      // Saving clears the name on the server: the browser must follow.
      yield* session.dispatch(Message.SubmittedGreeting())
      yield* waitFor(session, model => model.greetings.length > 0)
      const cleared = yield* session.render
      assert.deepStrictEqual(cleared.signals, { _hvName: '' })
      yield* session.close
    }),
  )
})

describe('handler tables', () => {
  it.live('resolve handlers from earlier renders, so in-flight events survive morphs', () =>
    Effect.gen(function* () {
      const session = yield* fresh()
      const first = yield* session.render
      yield* session.render
      yield* session.render
      assert.deepStrictEqual(
        session.resolve({ h: handlerIdOf(first.html), v: 'Ada' }),
        Option.some(Message.ChangedName({ name: 'Ada' })),
      )
      yield* session.close
    }),
  )
})

describe('publishing the Model', () => {
  const Counter = defineMessageUnion({ Noted: {}, Bumped: {} })
  type Counter = typeof Counter.Type
  const counter: Program<number, Counter, Counter> = {
    name: 'publish',
    Model: S.Number,
    ClientMessage: Counter,
    flags: () => Effect.void,
    init: () => ({ model: 0 }),
    // Noted leaves the Model as it was (it would start a Command in an app).
    update: (model, message) => ({ model: message._tag === 'Bumped' ? model + 1 : model }),
    view: (model, h) => ({ title: String(model), body: h.p([], [String(model)]) }),
  }

  it.live('renders nothing for a Message that leaves the Model unchanged', () =>
    Effect.gen(function* () {
      const session = yield* Session.make(counter, 'publish', { model: 0, firstSequence: 1 })
      let published = 0
      yield* SubscriptionRef.changes(session.model).pipe(
        Stream.runForEach(() => Effect.sync(() => (published += 1))),
        Effect.forkChild,
      )
      yield* Effect.sleep('20 millis')
      for (const message of [Counter.Noted(), Counter.Noted(), Counter.Bumped(), Counter.Noted()]) {
        yield* session.dispatch(message)
      }
      yield* Effect.sleep('50 millis')
      // The current Model on subscribing, then Bumped only.
      assert.strictEqual(published, 2)
      assert.strictEqual(session.applied().model, 1)
      yield* session.close
    }),
  )
})
