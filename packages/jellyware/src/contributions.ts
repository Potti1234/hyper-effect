import { Context, Effect, Layer, Schema as S, type Scope, type Stream, SubscriptionRef } from 'effect'

/* What extensions add to the app's own pages, with a change feed pages
   subscribe to. Every entry belongs to the scope that added it: an
   extension's entries go when the extension is unmounted.

   Entries are kept in a stack per id, as Powermove's registries do: an entry
   with the id of one already there takes its place until its scope closes,
   which brings the earlier one back. A new version of an extension is
   mounted before the old one is closed, so its entries replace the old ones
   without the sidebar losing them in between. */

/** A sidebar entry. `icon` is a name from the app's icon set. */
export const NavEntry = S.Struct({
  id: S.String,
  label: S.String,
  href: S.String,
  icon: S.String,
})
export type NavEntry = typeof NavEntry.Type

type Registered = Readonly<{ seq: number; entry: NavEntry }>

export class Contributions extends Context.Service<
  Contributions,
  {
    /** Adds a sidebar entry for the life of the current scope. */
    readonly nav: (entry: NavEntry) => Effect.Effect<void, never, Scope.Scope>
    /** The sidebar entries now, then after every change, in the order
     *  their ids were first added. */
    readonly navChanges: Stream.Stream<ReadonlyArray<NavEntry>>
    readonly navEntries: Effect.Effect<ReadonlyArray<NavEntry>>
  }
>()('@hyper-effect/jellyware/Contributions') {
  static readonly layer: Layer.Layer<Contributions> = Layer.effect(
    Contributions,
    Effect.gen(function* () {
      const stacks = new Map<string, ReadonlyArray<Registered>>()
      let seq = 0
      const live = yield* SubscriptionRef.make<ReadonlyArray<NavEntry>>([])
      const publish = Effect.suspend(() =>
        SubscriptionRef.set(
          live,
          [...stacks.values()].flatMap(stack => stack.slice(-1).map(registered => registered.entry)),
        ),
      )

      return Contributions.of({
        nav: entry =>
          Effect.suspend(() => {
            const registered: Registered = { seq: seq++, entry }
            return Effect.acquireRelease(
              Effect.suspend(() => {
                stacks.set(entry.id, [...(stacks.get(entry.id) ?? []), registered])
                return publish
              }),
              () =>
                Effect.suspend(() => {
                  const rest = (stacks.get(entry.id) ?? []).filter(other => other.seq !== registered.seq)
                  if (rest.length === 0) stacks.delete(entry.id)
                  else stacks.set(entry.id, rest)
                  return publish
                }),
            )
          }),
        navChanges: SubscriptionRef.changes(live),
        navEntries: SubscriptionRef.get(live),
      })
    }),
  )
}
