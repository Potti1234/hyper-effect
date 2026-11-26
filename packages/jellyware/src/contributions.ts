import { Cause, Context, Deferred, Duration, Effect, Layer, Schema as S, type Scope, Stream, SubscriptionRef } from 'effect'

/* What extensions add to the app's own pages, with change feeds the pages
   subscribe to. Every entry belongs to the scope that added it: an
   extension's entries go when the extension is unmounted.

   Entries are kept in a stack per id, as Powermove's registries do: an entry
   with the id of one already there takes its place until its scope closes,
   which brings the earlier one back. A new version of an extension is
   mounted before the old one is closed, so its entries replace the old ones
   without a page losing them in between.

   Four kinds:
   - Sidebar entries: plain data.
   - Slots: places in the app's pages (named by the app, such as
     `issue.sidebar`) where extensions show content. An extension gives a
     function from the page's context (which issue, who looks) to a stream
     of `SlotContent`, plain data the page renders itself. Extension code
     runs in the page's Subscription, never in its update or view, and a
     stream that fails shows as a failed card instead of breaking the page.
     A slot shows once every card has content; a card that has none after
     `cardTimeout` shows as loading, so one slow card does not hide the
     others. A page decides how it shows a slot's content: as cards, as
     entries of a menu, and so on.
   - Badges: short labels a page shows on things it lists (issues), by the
     thing's id. Like slots, from a stream per context; a stream that fails
     or has nothing yet adds no badges.
   - Commands: what a slot's actions run, by id, with JSON arguments, for a
     member. A page only runs actions it shows (they are in its Model), so a
     browser cannot invent a command or its arguments. A command may name
     the roles that may run it; the registry asks the app for the member's
     roles (`rolesOf`) before `run`, and leaves the action out of the cards
     of a member without one (the member looking is the slot context's
     `memberId`).

   Every entry remembers the extension that added it (`CurrentExtension`,
   provided by the loader while it builds an extension), so `inventory`
   can say what each extension contributes. */

/** The extension being built: its id, or null for the app's own code. */
export const CurrentExtension = Context.Reference<string | null>('@hyper-effect/jellyware/CurrentExtension', {
  defaultValue: () => null,
})

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

export const BadgeTone = S.Literals(['neutral', 'info', 'success', 'warning', 'danger'])
export type BadgeTone = typeof BadgeTone.Type

/** A short label on one thing a page lists. */
export const Badge = S.Struct({
  /** The id of the thing it marks, as the slot names it (an issue's id). */
  target: S.String,
  label: S.String,
  tone: BadgeTone,
})
export type Badge = typeof Badge.Type

/** A badge as a page keeps it: with the id of the entry that gave it. */
export const SlotBadge = S.Struct({ source: S.String, ...Badge.fields })
export type SlotBadge = typeof SlotBadge.Type

const Owner = S.NullOr(S.String)

/** What is registered now, the newest entry of each id, with the
 *  extension that added it (null: the app). */
export const Inventory = S.Struct({
  nav: S.Array(S.Struct({ entry: NavEntry, owner: Owner })),
  slots: S.Array(S.Struct({ slot: S.String, id: S.String, owner: Owner })),
  badges: S.Array(S.Struct({ slot: S.String, id: S.String, owner: Owner })),
  commands: S.Array(S.Struct({ id: S.String, roles: S.NullOr(S.Array(S.String)), owner: Owner })),
})
export type Inventory = typeof Inventory.Type

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

export type BadgeEntry<R = never> = Readonly<{
  /** The slot's name, such as `issues.badges`. */
  slot: string
  /** Unique per slot; a newer entry with the same id replaces the older. */
  id: string
  /** The badges for a page's context, now and whenever they change. */
  content: (context: SlotContext) => Stream.Stream<ReadonlyArray<Badge>, never, R>
}>

/** Who runs a command, and with what. `context` is what the caller knows
 *  of where it runs, as strings (the thread an agent's tool works for, the
 *  page an action was clicked on); each app documents its keys, as for
 *  slots. A command must not trust it more than `args`. */
export type CommandInput = Readonly<{ args: S.Json; memberId: string; context?: SlotContext }>

export type CommandEntry<R = never> = Readonly<{
  id: string
  /** Members with one of these roles may run it; without, every member
   *  who sees the action. The registry checks this before `run`. */
  roles?: ReadonlyArray<string>
  /** Answers with a line for the member ("Marked ENG-4 urgent"), or fails
   *  with one. Decode `args` here and check what the roles do not cover
   *  (that the member may change this issue, say): the page only
   *  guarantees that it showed this action. */
  run: (input: CommandInput) => Effect.Effect<string, string, R>
}>

export type ContributionsOptions<R> = Readonly<{
  /** How long a slot card may go without content before it shows as
   *  loading. Default one second. */
  cardTimeout?: Duration.Input
  /** The roles of a member, for commands that name roles. Without it, such
   *  commands are refused to everyone. */
  rolesOf?: (memberId: string) => Effect.Effect<ReadonlyArray<string>, never, R>
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
    /** Adds badges to a slot for the life of the current scope. */
    readonly badges: <R>(entry: BadgeEntry<R>) => Effect.Effect<void, never, Scope.Scope | R>
    /** The badges of a slot for a context, from every entry, now and after
     *  every change. */
    readonly slotBadges: (slot: string, context: SlotContext) => Stream.Stream<ReadonlyArray<SlotBadge>>
    /** Adds a command for the life of the current scope. */
    readonly command: <R>(entry: CommandEntry<R>) => Effect.Effect<void, never, Scope.Scope | R>
    /** Runs a command; fails with a line for the member when it is gone or
     *  fails. */
    readonly run: (id: string, input: CommandInput) => Effect.Effect<string, string>
    /** Everything registered now, with who added it. */
    readonly inventory: Effect.Effect<Inventory>
    /** The same, now and after every change. */
    readonly inventoryChanges: Stream.Stream<Inventory>
  }
>()('@hyper-effect/jellyware/Contributions') {
  /** The registry. */
  static readonly make = <R = never>(options: ContributionsOptions<R> = {}): Layer.Layer<Contributions, never, R> =>
    Layer.effect(
      Contributions,
      Effect.gen(function* () {
        const cardTimeout = options.cardTimeout ?? Duration.seconds(1)
        const navs = yield* stacks<NavEntry>()
        const slots = yield* stacks<SlotEntry>()
        const commands = yield* stacks<CommandEntry>()
        const badgeEntries = yield* stacks<BadgeEntry>()
        const appServices = yield* Effect.context<R>()

        const inventoryNow = (): Inventory => ({
          nav: navs.owned().map(({ value, owner }) => ({ entry: value, owner })),
          slots: slots.owned().map(({ value, owner }) => ({ slot: value.slot, id: value.id, owner })),
          badges: badgeEntries.owned().map(({ value, owner }) => ({ slot: value.slot, id: value.id, owner })),
          commands: commands.owned().map(({ value, owner }) => ({ id: value.id, roles: value.roles ?? null, owner })),
        })

        const rolesOf = (memberId: string): Effect.Effect<ReadonlyArray<string>> =>
          options.rolesOf === undefined ? Effect.succeed([]) : options.rolesOf(memberId).pipe(Effect.provideContext(appServices))
        /** Whether `memberId` may run `command`; no member is no roles. */
        const mayRun = (command: CommandEntry, memberId: string | undefined) =>
          command.roles === undefined
            ? Effect.succeed(true)
            : Effect.map(memberId === undefined ? Effect.succeed([]) : rolesOf(memberId), roles =>
                command.roles?.some(role => roles.includes(role)) === true,
              )
        /** The card without the actions its viewer may not run. */
        const allowedActions = (content: SlotContent, memberId: string | undefined) =>
          content.actions.length === 0
            ? Effect.succeed(content)
            : Effect.gen(function* () {
                const live = yield* SubscriptionRef.get(commands.live)
                const actions = yield* Effect.filter(content.actions, action => {
                  const command = live.find(entry => entry.id === action.command)
                  return command === undefined ? Effect.succeed(true) : mayRun(command, memberId)
                })
                return actions.length === content.actions.length ? content : { ...content, actions }
              })

        return Contributions.of({
          nav: entry => Effect.flatMap(CurrentExtension, owner => navs.add(entry.id, entry, owner)),
          navChanges: SubscriptionRef.changes(navs.live),
          navEntries: SubscriptionRef.get(navs.live),
          slot: <R,>(entry: SlotEntry<R>) =>
            Effect.gen(function* () {
              // The extension's services, for content streams run by pages.
              const services = yield* Effect.context<R>()
              const owner = yield* CurrentExtension
              yield* slots.add(`${entry.slot}\u0000${entry.id}`, {
                slot: entry.slot,
                id: entry.id,
                content: context => entry.content(context).pipe(Stream.provideContext(services)),
              }, owner)
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
                        withFallback(
                          cardTimeout,
                          { title: entry.id, items: [], actions: [], note: 'Loading…' },
                          entry.content(context).pipe(
                            Stream.mapEffect(content => allowedActions(content, context['memberId'])),
                            Stream.catchCause(cause =>
                              Stream.succeed<SlotContent>({
                                title: entry.id,
                                items: [],
                                actions: [],
                                note: `This card failed: ${Cause.squash(cause)}`,
                              }),
                            ),
                          ),
                        ).pipe(Stream.map((content): SlotCard => ({ id: entry.id, content }))),
                      ),
                    ),
              ),
            ),
          badges: <R,>(entry: BadgeEntry<R>) =>
            Effect.gen(function* () {
              const services = yield* Effect.context<R>()
              const owner = yield* CurrentExtension
              yield* badgeEntries.add(
                `${entry.slot}\u0000${entry.id}`,
                {
                  slot: entry.slot,
                  id: entry.id,
                  content: context => entry.content(context).pipe(Stream.provideContext(services)),
                },
                owner,
              )
            }),
          slotBadges: (slot, context) =>
            SubscriptionRef.changes(badgeEntries.live).pipe(
              Stream.map(all => all.filter(entry => entry.slot === slot)),
              Stream.changesWith((a, b) => a.length === b.length && a.every((entry, index) => entry === b[index])),
              Stream.switchMap(entries =>
                entries.length === 0
                  ? Stream.succeed<ReadonlyArray<SlotBadge>>([])
                  : Stream.zipLatestAll(
                      ...entries.map(entry =>
                        withFallback(
                          cardTimeout,
                          [],
                          entry.content(context).pipe(
                            Stream.catchCause(cause =>
                              Stream.fromEffect(
                                Effect.as(Effect.logWarning(`jellyware: the badges of ${entry.id} failed`, cause), []),
                              ),
                            ),
                          ),
                        ).pipe(Stream.map(badges => badges.map((badge): SlotBadge => ({ source: entry.id, ...badge })))),
                      ),
                    ).pipe(Stream.map(lists => lists.flat())),
              ),
            ),
          command: <R,>(entry: CommandEntry<R>) =>
            Effect.gen(function* () {
              const services = yield* Effect.context<R>()
              const owner = yield* CurrentExtension
              yield* commands.add(entry.id, {
                id: entry.id,
                ...(entry.roles === undefined ? {} : { roles: entry.roles }),
                run: input => entry.run(input).pipe(Effect.provideContext(services)),
              }, owner)
            }),
          run: (id, input) =>
            Effect.flatMap(SubscriptionRef.get(commands.live), live => {
              const command = live.find(entry => entry.id === id)
              if (command === undefined) return Effect.fail('This action is no longer available.')
              return Effect.flatMap(mayRun(command, input.memberId), allowed =>
                allowed
                  ? command.run(input).pipe(Effect.catchDefect(defect => Effect.fail(`The action failed: ${String(defect)}`)))
                  : Effect.fail(`Only members with the role ${(command.roles ?? []).join(' or ')} may do this.`),
              )
            }),
          inventory: Effect.sync(inventoryNow),
          inventoryChanges: Stream.mergeAll(
            [
              SubscriptionRef.changes(navs.live).pipe(Stream.as(undefined)),
              SubscriptionRef.changes(slots.live).pipe(Stream.as(undefined)),
              SubscriptionRef.changes(badgeEntries.live).pipe(Stream.as(undefined)),
              SubscriptionRef.changes(commands.live).pipe(Stream.as(undefined)),
            ],
            { concurrency: 'unbounded' },
          ).pipe(Stream.map(inventoryNow), Stream.changesWith(sameInventory)),
        })
      }),
    )

  static readonly layer: Layer.Layer<Contributions> = Contributions.make()
}

const sameInventory = (a: Inventory, b: Inventory) => JSON.stringify(a) === JSON.stringify(b)

/** A stream preceded by `fallback` when it has emitted nothing after
 *  `timeout`. */
const withFallback = <A,>(timeout: Duration.Input, fallback: A, content: Stream.Stream<A>) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const arrived = yield* Deferred.make<void>()
      const loading = Stream.fromEffect(Effect.sleep(timeout)).pipe(
        Stream.filterEffect(() => Effect.map(Deferred.isDone(arrived), done => !done)),
        Stream.as(fallback),
      )
      return Stream.merge(content.pipe(Stream.tap(() => Deferred.succeed(arrived, undefined))), loading)
    }),
  )

/** A stack of entries per id; `live` holds the newest of each id, in the
 *  order the ids were first added, and `owned` the same with their owners. */
const stacks = <A>() =>
  Effect.gen(function* () {
    const byId = new Map<string, ReadonlyArray<Readonly<{ seq: number; value: A; owner: string | null }>>>()
    let seq = 0
    const live = yield* SubscriptionRef.make<ReadonlyArray<A>>([])
    const publish = Effect.suspend(() =>
      SubscriptionRef.set(
        live,
        [...byId.values()].flatMap(stack => stack.slice(-1).map(entry => entry.value)),
      ),
    )
    const owned = () => [...byId.values()].flatMap(stack => stack.slice(-1))
    const add = (id: string, value: A, owner: string | null): Effect.Effect<void, never, Scope.Scope> =>
      Effect.suspend(() => {
        const entry = { seq: seq++, value, owner }
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
    return { live, add, owned }
  })
