import { type Duration, Effect, Stream } from 'effect'

/** `f`, computed once per distinct input (by reference) and shared by every
 *  caller. For Messages built from a shared feed: every session of a page
 *  subscribes to the same store, and a Foldkit Message constructor validates
 *  and copies its payload, so without this each of N sessions builds its own
 *  copy of every change. With it they share one Message, and the deps of
 *  regions that read it compare by reference at once:
 *
 *  ```ts
 *  const changed = memoizeLast((state: State) => Message.ChangedStore(state))
 *  store.changes.pipe(Stream.map(changed))
 *  ``` */
export const memoizeLast = <A, B>(f: (input: A) => B): ((input: A) => B) => {
  let last: Readonly<{ input: A; output: B }> | undefined
  return input => {
    if (last === undefined || !Object.is(last.input, input)) last = { input, output: f(input) }
    return last.output
  }
}

/** Emits the first element at once, then at most one element per `interval`,
 *  always the newest. For high-churn shared feeds (presence, counters): every
 *  emission re-renders every page subscribed to it, so a burst of a thousand
 *  changes should cost a few renders, not a thousand. */
export const sampleLatest =
  (interval: Duration.Input) =>
  <A, E, R>(self: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
    self.pipe(
      Stream.buffer({ capacity: 1, strategy: 'sliding' }),
      Stream.flatMap(value =>
        Stream.concat(Stream.make(value), Stream.drain(Stream.fromEffect(Effect.sleep(interval)))),
      ),
    )
