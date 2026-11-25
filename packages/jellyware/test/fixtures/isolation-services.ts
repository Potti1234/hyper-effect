import { Context, Data, type Effect, type Stream } from 'effect'

import { remoteService } from '../../src/isolation/remote.ts'

/* A service of a test app, and how it crosses to an extension's process. */

export class NotAllowed extends Data.TaggedError('NotAllowed')<{ readonly reason: string }> {}

export class Counter extends Context.Service<
  Counter,
  {
    readonly current: Effect.Effect<number>
    readonly changes: Stream.Stream<number>
    readonly add: (n: number) => Effect.Effect<number, NotAllowed>
  }
>()('test/Counter') {}

export const remoteServices = [remoteService(Counter, { current: 'value', changes: 'stream', add: 'call' })]
