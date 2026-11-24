import { Cause, Context, Effect, Layer, Schema as S, type Scope, Stream, SubscriptionRef } from 'effect'

/* What extensions add to the app's own pages, with change feeds the pages
   subscribe to. Every entry belongs to the scope that added it: an
   extension's entries go when the extension is unmounted.

   Entries are kept in a stack per id, as Powermove's registries do: an entry
   with the id of one already there takes its place until its scope closes,
   which brings the earlier one back. A new version of an extension is
   mounted before the old one is closed, so its entries replace the old ones
   without a page losing them in between.

   Three kinds:
   - Sidebar entries: plain data.
   - Slots: places in the app's pages (named by the app, such as
     `issue.sidebar`) where extensions show content. An extension gives a
     function from the page's context (which issue, who looks) to a stream
     of `SlotContent`, plain data the page renders itself. Extension code
     runs in the page's Subscription, never in its update or view, and a
     stream that fails shows as a failed card instead of breaking the page.
   - Commands: what a slot's actions run, by id, with JSON arguments, for a
     member. A page only runs actions it shows (they are in its Model), so a
     browser cannot invent a command or its arguments. */

/** A sidebar entry. `icon` is a name from the app's icon set. */
export const NavEntry = S.Struct({
  id: S.String,
  label: S.String,
  href: S.String,
  icon: S.String,
})
export type NavEntry = typeof NavEntry.Type

export const SlotItem = S.Struct({
  label: S.String,
  detail: S.NullOr(S.String),
  href: S.NullOr(S.String),
})
export type SlotItem = typeof SlotItem.Type

/** A button in a slot: runs `command` with `args`. */
export const SlotAction = S.Struct({ label: S.String, command: S.String, args: S.Json })
export type SlotAction = typeof SlotAction.Type

/** What a slot shows for one extension: a card with items and actions. */
export const SlotContent = S.Struct({
  title: S.String,
  items: S.Array(SlotItem),
  actions: S.Array(SlotAction),
  /** A line under the items, such as "Nothing related"; or an error. */
  note: S.NullOr(S.String),
})
export type SlotContent = typeof SlotContent.Type

/** One extension's card in a slot, as a page keeps it. */
export const SlotCard = S.Struct({ id: S.String, content: SlotContent })
export type SlotCard = typeof SlotCard.Type

/** Where a slot is shown: what the page knows, as strings (an issue id, the
 *  member looking). Each slot documents its keys. */
export type SlotContext = Readonly<Record<string, string>>

export type SlotEntry<R = never> = Readonly<{
  /** The slot's name, such as `issue.sidebar`. */
  slot: string
  /** Unique per slot; a newer entry with the same id replaces the older. */
  id: string
  /** The content for a page's context, now and whenever it changes. It
   *  should emit at once: the slot shows once every card has content. */
  content: (context: SlotContext) => Stream.Stream<SlotContent, never, R>
}>

/** Who runs a command, and with what. */
export type CommandInput = Readonly<{ args: S.Json; memberId: string }>

export type CommandEntry<R = never> = Readonly<{
  id: string
  /** Answers with a line for the member ("Marked ENG-4 urgent"), or fails
   *  with one. Check the member's rights and decode `args` here: the page
   *  only guarantees that it showed this action. */
  run: (input: CommandInput) => Effect.Effect<string, string, R>
}>

export class Contributions extends Context.Service<
  Contributions,
  {
    /** Adds a sidebar entry for the life of the current scope. */
    readonly nav: (entry: NavEntry) => Effect.Effect<void, never, Scope.Scope>
    /** The sidebar entries now, then after every change, in the order
     *  their ids were first added. */
    readonly navChanges: Stream.Stream<ReadonlyArray<NavEntry>>
    readonly navEntries: Effect.Effect<ReadonlyArray<NavEntry>>
    /** Adds content to a slot for the life of the current scope. */
    readonly slot: <R>(entry: SlotEntry<R>) => Effect.Effect<void, never, Scope.Scope | R>
    /** The cards of a slot for a context, now and after every change of an
     *  entry or of its content. */
    readonly slotCards: (slot: string, context: SlotContext) => Stream.Stream<ReadonlyArray<SlotCard>>
    /** Adds a command for the life of the current scope. */
    readonly command: <R>(entry: CommandEntry<R>) => Effect.Effect<void, never, Scope.Scope | R>
    /** Runs a command; fails with a line for the member when it is gone or
     *  fails. */
    readonly run: (id: string, input: CommandInput) => Effect.Effect<string, string>
  }
>()('@hyper-effect/jellyware/Contributions') {
  static readonly layer: Layer.Layer<Contributions> = Layer.effect(
    Contributions,
    Effect.gen(function* () {
      const navs = yield* stacks<NavEntry>()
      const slots = yield* stacks<SlotEntry>()
      const commands = yield* stacks<CommandEntry>()

      return Contributions.of({
        nav: entry => navs.add(entry.id, entry),
        navChanges: SubscriptionRef.changes(navs.live),
        navEntries: SubscriptionRef.get(navs.live),
        slot: <R,>(entry: SlotEntry<R>) =>
          Effect.gen(function* () {
            // The extension's services, for content streams run by pages.
            const services = yield* Effect.context<R>()
            yield* slots.add(`${entry.slot}\u0000${entry.id}`, {
              slot: entry.slot,
              id: entry.id,
              content: context => entry.content(context).pipe(Stream.provideContext(services)),
            })
          }),
        slotCards: (slot, context) =>
          SubscriptionRef.changes(slots.live).pipe(
            Stream.map(all => all.filter(entry => entry.slot === slot)),
            Stream.changesWith((a, b) => a.length === b.length && a.every((entry, index) => entry === b[index])),
            Stream.switchMap(entries =>
              entries.length === 0
                ? Stream.succeed<ReadonlyArray<SlotCard>>([])
                : Stream.zipLatestAll(
                    ...entries.map(entry =>
                      entry.content(context).pipe(
                        Stream.catchCause(cause =>
                          Stream.succeed<SlotContent>({
                            title: entry.id,
                            items: [],
                            actions: [],
                            note: `This card failed: ${Cause.squash(cause)}`,
                          }),
                        ),
                        Stream.map((content): SlotCard => ({ id: entry.id, content })),
                      ),
                    ),
                  ),
            ),
          ),
        command: <R,>(entry: CommandEntry<R>) =>
          Effect.gen(function* () {
            const services = yield* Effect.context<R>()
            yield* commands.add(entry.id, {
              id: entry.id,
              run: input => entry.run(input).pipe(Effect.provideContext(services)),
            })
          }),
        run: (id, input) =>
          Effect.flatMap(SubscriptionRef.get(commands.live), live => {
            const command = live.find(entry => entry.id === id)
            return command === undefined
              ? Effect.fail('This action is no longer available.')
              : command.run(input).pipe(
                  Effect.catchDefect(defect => Effect.fail(`The action failed: ${String(defect)}`)),
                )
          }),
      })
    }),
  )
}

/** A stack of entries per id; `live` holds the newest of each id, in the
 *  order the ids were first added. */
const stacks = <A>() =>
  Effect.gen(function* () {
    const byId = new Map<string, ReadonlyArray<Readonly<{ seq: number; value: A }>>>()
    let seq = 0
    const live = yield* SubscriptionRef.make<ReadonlyArray<A>>([])
    const publish = Effect.suspend(() =>
      SubscriptionRef.set(
        live,
        [...byId.values()].flatMap(stack => stack.slice(-1).map(entry => entry.value)),
      ),
    )
    const add = (id: string, value: A): Effect.Effect<void, never, Scope.Scope> =>
      Effect.suspend(() => {
        const entry = { seq: seq++, value }
        return Effect.acquireRelease(
          Effect.suspend(() => {
            byId.set(id, [...(byId.get(id) ?? []), entry])
            return publish
          }),
          () =>
            Effect.suspend(() => {
              const rest = (byId.get(id) ?? []).filter(other => other.seq !== entry.seq)
              if (rest.length === 0) byId.delete(id)
              else byId.set(id, rest)
              return publish
            }),
        )
      })
    return { live, add }
  })
