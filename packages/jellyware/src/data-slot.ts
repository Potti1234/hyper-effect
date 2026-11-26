import { Effect, Option, Schema as S, type Scope, Stream } from 'effect'

import { Contributions, type SlotContext, type SlotRead } from './contributions.ts'

/* A data slot with a type: the app names it and gives the Schema of its
   values; extensions add values, the app reads them. Values cross the
   process boundary as JSON (`Schema.toCodecJson`), so any Schema works. A
   value that does not decode is left out, with a warning.

     export const Instructions = dataSlot('agent.instructions', S.String)
     // in an extension:
     yield* Instructions.add('memory', context => memories.pipe(Stream.map(toText)))
     // in the app:
     const texts = Instructions.read({ threadId })   // Stream<ReadonlyArray<{ id, value: string }>> */

export type DataSlot<A> = Readonly<{
  name: string
  /** Adds this extension's value for the life of the current scope;
   *  `content` should emit at once and again when the value changes. */
  add: <R>(id: string, content: (context: SlotContext) => Stream.Stream<A, never, R>) => Effect.Effect<void, never, Contributions | Scope.Scope | R>
  /** Every entry's value for a context, now and after every change. */
  read: (context: SlotContext, read?: SlotRead) => Stream.Stream<ReadonlyArray<Readonly<{ id: string; value: A }>>, never, Contributions>
  /** The values once (the first emission). */
  current: (context: SlotContext) => Effect.Effect<ReadonlyArray<Readonly<{ id: string; value: A }>>, never, Contributions>
}>

type Value<A> = Readonly<{ id: string; value: A }>

export const dataSlot = <A, I>(name: string, schema: S.Codec<A, I>): DataSlot<A> => {
  const json = S.toCodecJson(schema)
  const encode = S.encodeEffect(json)
  const decode = S.decodeUnknownEffect(json)
  /** The values that decode; the others are left out with a warning. */
  const decodeAll = (values: ReadonlyArray<Readonly<{ id: string; value: S.Json }>>): Effect.Effect<ReadonlyArray<Value<A>>> =>
    Effect.map(
      Effect.forEach(values, ({ id, value }) =>
        decode(value).pipe(
          Effect.map((decoded): Value<A> | null => ({ id, value: decoded })),
          Effect.catch(error => Effect.as(Effect.logWarning(`jellyware: a value of ${id} in ${name} does not fit: ${String(error)}`), null)),
        ),
      ),
      list => list.filter((each): each is Value<A> => each !== null),
    )
  const read = (context: SlotContext, options?: SlotRead): Stream.Stream<ReadonlyArray<Value<A>>, never, Contributions> =>
    Stream.unwrap(Contributions.use(contributions => Effect.succeed(contributions.slotData(name, context, options).pipe(Stream.mapEffect(decodeAll)))))
  return {
    name,
    add: (id, content) =>
      Contributions.use(contributions =>
        contributions.data({
          slot: name,
          id,
          content: context => content(context).pipe(Stream.mapEffect(value => Effect.orDie(encode(value)))),
        }),
      ),
    read,
    current: context => Effect.map(Stream.runHead(read(context)), Option.getOrElse((): ReadonlyArray<Value<A>> => [])),
  }
}
