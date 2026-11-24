import { assert, describe, it } from '@effect/vitest'
import { Context, Effect, Exit, Fiber, Scope, Stream } from 'effect'
import { TestClock } from 'effect/testing'

import { Contributions, type SlotCard, type SlotContent } from '../src/contributions'

/* Slots and commands: cards per context, failures contained, entries owned
   by the scope that added them. */

class Greeting extends Context.Service<Greeting, string>()('test/Greeting') {}

const card = (title: string, note: string | null = null): SlotContent => ({ title, items: [], actions: [], note })

const firstCards = (stream: Stream.Stream<ReadonlyArray<SlotCard>>) =>
  Stream.runHead(stream).pipe(Effect.map(head => (head._tag === 'Some' ? head.value : [])))

describe('contributions: slots and commands', () => {
  it.effect('shows each extension’s card for the context, and drops it with its scope', () =>
    Effect.gen(function* () {
      const contributions = yield* Contributions
      const scope = yield* Scope.make()
      // The content stream uses a service of the extension that added it.
      yield* contributions
        .slot({
          slot: 'issue.sidebar',
          id: 'related',
          content: context => Stream.fromEffect(Effect.map(Greeting, greeting => card(`${greeting} ${context['issueId']}`))),
        })
        .pipe(Effect.provideService(Greeting, 'Related to'), Scope.provide(scope))
      yield* contributions.slot({ slot: 'issue.sidebar', id: 'broken', content: () => Stream.die('boom') }).pipe(Scope.provide(scope))
      yield* contributions.slot({ slot: 'other.slot', id: 'elsewhere', content: () => Stream.succeed(card('Elsewhere')) }).pipe(Scope.provide(scope))

      const cards = yield* firstCards(contributions.slotCards('issue.sidebar', { issueId: 'ENG-1' }))
      assert.deepStrictEqual(cards.map(each => each.id), ['related', 'broken'])
      assert.strictEqual(cards[0]?.content.title, 'Related to ENG-1')
      assert.include(cards[1]?.content.note ?? '', 'This card failed')

      yield* Scope.close(scope, Exit.void)
      assert.deepStrictEqual(yield* firstCards(contributions.slotCards('issue.sidebar', { issueId: 'ENG-1' })), [])
    }).pipe(Effect.provide(Contributions.layer)),
  )

  it.effect('shows a card without content as loading after the time limit, so the others show', () =>
    Effect.gen(function* () {
      const contributions = yield* Contributions
      const scope = yield* Scope.make()
      yield* contributions.slot({ slot: 's', id: 'quick', content: () => Stream.succeed(card('Quick')) }).pipe(Scope.provide(scope))
      yield* contributions
        .slot({ slot: 's', id: 'slow', content: () => Stream.fromEffect(Effect.as(Effect.sleep('5 seconds'), card('Slow'))) })
        .pipe(Scope.provide(scope))
      const fiber = yield* contributions.slotCards('s', {}).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild)
      // A second at a time: each step lets the slot's fibers start their timers.
      for (let second = 0; second < 6; second++) {
        yield* Effect.yieldNow
        yield* TestClock.adjust('1 second')
      }
      const seen = yield* Fiber.join(fiber)
      assert.deepStrictEqual(
        seen.map(cards => cards.map(each => each.content.note ?? each.content.title)),
        [
          ['Quick', 'Loading…'],
          ['Quick', 'Slow'],
        ],
      )
    }).pipe(Effect.provide(Contributions.layer)),
  )

  it.effect('lets a newer entry with the same id replace the card until it goes', () =>
    Effect.gen(function* () {
      const contributions = yield* Contributions
      const older = yield* Scope.make()
      const newer = yield* Scope.make()
      yield* contributions.slot({ slot: 's', id: 'x', content: () => Stream.succeed(card('old')) }).pipe(Scope.provide(older))
      yield* contributions.slot({ slot: 's', id: 'x', content: () => Stream.succeed(card('new')) }).pipe(Scope.provide(newer))
      assert.deepStrictEqual((yield* firstCards(contributions.slotCards('s', {}))).map(each => each.content.title), ['new'])
      yield* Scope.close(newer, Exit.void)
      assert.deepStrictEqual((yield* firstCards(contributions.slotCards('s', {}))).map(each => each.content.title), ['old'])
    }).pipe(Effect.provide(Contributions.layer)),
  )

  it.effect('runs commands with their extension’s services, and reports gone or failing ones', () =>
    Effect.gen(function* () {
      const contributions = yield* Contributions
      const scope = yield* Scope.make()
      yield* contributions
        .command({
          id: 'greet',
          run: ({ args, memberId }) => Effect.map(Greeting, greeting => `${greeting}, ${memberId} (${JSON.stringify(args)})`),
        })
        .pipe(Effect.provideService(Greeting, 'Hello'), Scope.provide(scope))
      yield* contributions.command({ id: 'refuse', run: () => Effect.fail('Not allowed.') }).pipe(Scope.provide(scope))
      yield* contributions.command({ id: 'crash', run: () => Effect.die('bug') }).pipe(Scope.provide(scope))

      assert.strictEqual(yield* contributions.run('greet', { args: { n: 1 }, memberId: 'ada' }), 'Hello, ada ({"n":1})')
      assert.strictEqual(yield* Effect.flip(contributions.run('refuse', { args: null, memberId: 'ada' })), 'Not allowed.')
      assert.include(yield* Effect.flip(contributions.run('crash', { args: null, memberId: 'ada' })), 'The action failed')
      yield* Scope.close(scope, Exit.void)
      assert.strictEqual(
        yield* Effect.flip(contributions.run('greet', { args: null, memberId: 'ada' })),
        'This action is no longer available.',
      )
    }).pipe(Effect.provide(Contributions.layer)),
  )
  it.effect('checks the roles a command names, and leaves its action out of the cards of members without one', () =>
    Effect.gen(function* () {
      const contributions = yield* Contributions
      const scope = yield* Scope.make()
      yield* contributions.command({ id: 'close', roles: ['admin'], run: ({ memberId }) => Effect.succeed(`Closed by ${memberId}`) }).pipe(Scope.provide(scope))
      yield* contributions.command({ id: 'watch', run: ({ memberId }) => Effect.succeed(`Watched by ${memberId}`) }).pipe(Scope.provide(scope))
      yield* contributions
        .slot({
          slot: 's',
          id: 'card',
          content: () =>
            Stream.succeed({
              ...card('Card'),
              actions: [
                { label: 'Close', command: 'close', args: null },
                { label: 'Watch', command: 'watch', args: null },
              ],
            }),
        })
        .pipe(Scope.provide(scope))

      assert.strictEqual(yield* contributions.run('close', { args: null, memberId: 'ada' }), 'Closed by ada')
      assert.strictEqual(yield* Effect.flip(contributions.run('close', { args: null, memberId: 'grace' })), 'Only members with the role admin may do this.')
      assert.strictEqual(yield* contributions.run('watch', { args: null, memberId: 'grace' }), 'Watched by grace')

      const labels = (memberId?: string) =>
        firstCards(contributions.slotCards('s', memberId === undefined ? {} : { memberId })).pipe(
          Effect.map(cards => cards.flatMap(each => each.content.actions.map(action => action.label))),
        )
      assert.deepStrictEqual(yield* labels('ada'), ['Close', 'Watch'])
      assert.deepStrictEqual(yield* labels('grace'), ['Watch'])
      assert.deepStrictEqual(yield* labels(), ['Watch'])
      yield* Scope.close(scope, Exit.void)
    }).pipe(Effect.provide(Contributions.make({ rolesOf: memberId => Effect.succeed(memberId === 'ada' ? ['admin'] : ['member']) }))),
  )

  it.effect('refuses commands that name roles when the app does not say who has which', () =>
    Effect.gen(function* () {
      const contributions = yield* Contributions
      const scope = yield* Scope.make()
      yield* contributions.command({ id: 'close', roles: ['admin'], run: () => Effect.succeed('Closed') }).pipe(Scope.provide(scope))
      assert.include(yield* Effect.flip(contributions.run('close', { args: null, memberId: 'ada' })), 'role admin')
      yield* Scope.close(scope, Exit.void)
    }).pipe(Effect.provide(Contributions.layer)),
  )
})
