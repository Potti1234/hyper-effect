import { expect, it } from '@effect/vitest'
import type { Program } from '../src/program'
import * as Hyper from '../src/server'
import {
  openPage,
  openStream,
  readUntil,
  serve,
} from '../src/testing'
import { Context, Deferred, Effect, Exit, Fiber, Layer, Ref, Schema } from 'effect'
import { KeyValueStore } from 'effect/persistence'
import { HttpRouter, HttpServer } from 'effect/http'
import { Command } from 'foldkit'

it.live(
  'closes session workers and awaits the final retained snapshot before releasing its store',
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const stopped = yield* Deferred.make<void>()
      const writing = yield* Deferred.make<void>()
      const allowWrite = yield* Deferred.make<void>()
      const disposed = yield* Deferred.make<void>()
      const closed = yield* Ref.make(false)
      const writesAfterClose = yield* Ref.make(0)
      const base = Context.get(
        yield* Layer.build(KeyValueStore.layerMemory),
        KeyValueStore.KeyValueStore,
      )
      const store = KeyValueStore.make({
        ...base,
        set: (key, value) =>
          Effect.gen(function* () {
            if (yield* Ref.get(closed))
              yield* Ref.update(writesAfterClose, (count) => count + 1)
            yield* Deferred.succeed(writing, undefined)
            yield* Deferred.await(allowWrite)
            yield* base.set(key, value)
          }),
      })
      const storeLayer = Layer.effect(
        KeyValueStore.KeyValueStore,
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Ref.set(closed, true))
          return store
        }),
      )
      const Worker = Command.define('Lifecycle.worker', {
        args: {},
        messages: [],
        execute: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
          ),
      })
      const Model = Schema.Struct({ count: Schema.Number })
      type Model = typeof Model.Type
      const program: Program<Model, never, never, Model> = {
        name: 'lifecycle',
        Model,
        ClientMessage: Schema.Never,
        flags: () => Effect.succeed({ count: 7 }),
        init: (model) => ({ model, commands: [Worker({})] }),
        update: (model) => ({ model }),
        view: (model, h) => ({
          title: 'Lifecycle',
          body: h.div([], [`Count: ${model.count}`]),
        }),
      }
      const app = HttpRouter.toWebHandler(
        Hyper.layer(program).pipe(
          Layer.provide([HttpServer.layerServices, storeLayer]),
        ),
        { disableLogger: true },
      )
      yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()))
      const page = yield* Effect.promise(() => openPage(app.handler))
      expect(page.response.status).toBe(200)
      yield* Deferred.await(started)
      const disposing = yield* Effect.promise(() => app.dispose()).pipe(
        Effect.tap(() => Deferred.succeed(disposed, undefined)),
        Effect.forkScoped,
      )
      yield* Effect.gen(function* () {
        yield* Deferred.await(writing)
        expect(yield* Deferred.isDone(stopped)).toBe(true)
        expect(yield* Ref.get(closed)).toBe(false)
        expect(yield* Deferred.isDone(disposed)).toBe(false)
      }).pipe(Effect.ensuring(Deferred.succeed(allowWrite, undefined)))
      yield* Fiber.join(disposing)
      expect(yield* Ref.get(closed)).toBe(true)
      expect(yield* Ref.get(writesAfterClose)).toBe(0)
      const value = yield* base.get(`hyper/${page.program}/${page.sessionId}`)
      expect(value).toBeDefined()
      const Snapshot = Schema.fromJsonString(Schema.Struct({ model: Model }))
      expect(
        (yield* Schema.decodeUnknownEffect(Snapshot)(value)).model.count,
      ).toBe(7)

      // A reopened handler must restore that same retained session, rather than
      // recomputing its changed flags after clean shutdown.
      const reopened = serve(
        {
          ...program,
          flags: () => Effect.succeed({ count: 99 }),
          init: (model) => ({ model }),
        },
        {},
        Context.make(KeyValueStore.KeyValueStore, base),
      )
      yield* Effect.addFinalizer(() => Effect.promise(() => reopened.dispose()))
      const restored = yield* Effect.promise(() =>
        openStream(reopened.handler, page),
      )
      expect(restored.status).toBe(200)
      expect(
        yield* Effect.promise(() => readUntil(restored, 'Count: 7')),
      ).toContain('Count: 7')
      yield* Effect.promise(() => reopened.dispose())
      expect(yield* Ref.get(writesAfterClose)).toBe(0)
    }).pipe(Effect.scoped, Effect.timeout('10 seconds')),
)

it.live('rejects a page whose flags finish after its server layer has closed', () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const releaseFlags = yield* Deferred.make<void>()
    const workerActive = yield* Ref.make(false)
    const base = Context.get(
      yield* Layer.build(KeyValueStore.layerMemory),
      KeyValueStore.KeyValueStore,
    )
    const Worker = Command.define('LateLifecycle.worker', {
      args: {},
      messages: [],
      execute: () => Ref.set(workerActive, true).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Ref.set(workerActive, false)),
      ),
    })
    const Model = Schema.Struct({ count: Schema.Number })
    const program: Program<typeof Model.Type, never, never, typeof Model.Type> = {
      name: 'late-lifecycle',
      Model,
      ClientMessage: Schema.Never,
      flags: () => Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(releaseFlags)),
        Effect.as({ count: 7 }),
      ),
      init: model => ({ model, commands: [Worker({})] }),
      update: model => ({ model }),
      view: (model, h) => ({ title: 'Late lifecycle', body: h.div([], [`Count: ${model.count}`]) }),
    }
    const app = serve(program, {}, Context.make(KeyValueStore.KeyValueStore, base))
    yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()))
    const pending = yield* Effect.promise(() => app.handler(new Request('http://localhost/'))).pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    yield* Effect.promise(() => app.dispose())
    yield* Deferred.succeed(releaseFlags, undefined)
    const result = yield* Effect.exit(Fiber.join(pending))
    if (Exit.isSuccess(result)) expect(result.value.status).not.toBe(200)
    expect(yield* Ref.get(workerActive)).toBe(false)
    expect(yield* base.size).toBe(0)
  }).pipe(Effect.scoped, Effect.timeout('10 seconds')),
)
