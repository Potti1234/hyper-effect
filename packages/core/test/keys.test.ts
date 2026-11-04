import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, Option, Schema as S } from 'effect'
import type { HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import { foldkitUiCommands } from '../src/client-commands'
import { type KeyBinding, keyBindings } from '../src/keys'
import type { Program } from '../src/program'
import { region } from '../src/region'
import * as Session from '../src/session'

/* Global key bindings (keys.ts): the table the page script matches against. */

const Message = defineMessageUnion({ PressedCreate: {}, PressedPalette: {}, PressedGoMine: {}, Internal: {} })
type Message = typeof Message.Type
const ClientMessage = S.Union([Message.PressedCreate, Message.PressedPalette, Message.PressedGoMine])

const programWith = (bindings: (isOpen: boolean) => ReadonlyArray<KeyBinding<Message>>): Program<boolean, Message, Message> => ({
  name: 'keys',
  Model: S.Boolean,
  /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
  ClientMessage: ClientMessage as unknown as S.Codec<Message, unknown, never, never>,
  flags: () => Effect.void,
  init: () => ({ model: false }),
  update: model => ({ model }),
  view: (isOpen: boolean, h: HtmlBuilder<Message>) => ({ title: 'keys', body: h.main([], [keyBindings(h, bindings(isOpen))]) }),
})

const render = (program: Program<boolean, Message, Message>, model = false) =>
  Effect.gen(function* () {
    const session = yield* Session.make(program, 'keys', { model, firstSequence: 1 })
    const exit = yield* Effect.exit(session.render)
    yield* session.close
    return exit
  })

const tableOf = (html: string) => {
  const encoded = html.match(/data-hyper-keys="([^"]+)"/)?.[1] ?? ''
  return JSON.parse(encoded.replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
}
const fieldOf = (payload: string) => /^([mh]): '([^']*)'$/.exec(payload)?.[2] ?? ''

describe('key bindings', () => {
  it.effect('render a window listener and a table of presses and Message tokens', () =>
    Effect.gen(function* () {
      const exit = yield* render(
        programWith(isOpen => [
          { keys: 'C', message: Message.PressedCreate() },
          { keys: 'Mod+K', message: Message.PressedPalette(), whileTyping: 'Allow' },
          { keys: ['G', 'M'], message: Message.PressedGoMine(), preventDefault: false },
          { keys: 'Escape', message: Message.PressedPalette(), isEnabled: isOpen },
        ]),
      )
      assert.isTrue(Exit.isSuccess(exit))
      const html = Exit.isSuccess(exit) ? exit.value.html : ''
      assert.include(html, 'data-on:keydown__window="(evt.hyperKey = window.hyperKeys?.(evt, el, $_hq + 1))')
      const table = tableOf(html)
      assert.strictEqual(table.t, 1000)
      // Disabled bindings are left out.
      assert.strictEqual(table.b.length, 3)
      assert.deepStrictEqual(table.b[0].p, [['c', false, false, false, false, false]])
      assert.deepStrictEqual(table.b[1].p, [['k', false, false, false, false, true]])
      assert.isTrue(table.b[1].w)
      assert.deepStrictEqual(table.b[2].p.map((press: ReadonlyArray<unknown>) => press[0]), ['g', 'm'])
      assert.isFalse(table.b[2].d)
      assert.match(table.b[0].x, /^m: '/)
      assert.deepStrictEqual(
        JSON.parse(Buffer.from(fieldOf(table.b[0].x), 'base64url').toString('utf8')),
        { _tag: 'PressedCreate' },
      )
    }),
  )

  it.effect('refuse invalid keys and duplicates, as Foldkit does', () =>
    Effect.gen(function* () {
      for (const keys of ['Ctrl+K', 'Mod+', 'Shift', 'Mod+Mod+K', 'Mod+Control+K']) {
        const exit = yield* render(programWith(() => [{ keys, message: Message.PressedCreate() }]))
        assert.isTrue(Exit.isFailure(exit), keys)
      }
      const duplicate = yield* render(
        programWith(() => [
          { keys: 'c', message: Message.PressedCreate() },
          { keys: 'C', message: Message.PressedPalette() },
        ]),
      )
      assert.isTrue(Exit.isFailure(duplicate))
    }),
  )

  it.effect('bind ClientMessages only', () =>
    Effect.gen(function* () {
      const exit = yield* render(programWith(() => [{ keys: 'X', message: Message.Internal() }]))
      assert.isTrue(Exit.isFailure(exit))
    }),
  )
})

describe('forwarded Foldkit UI Commands', () => {
  it('click, focus and scroll by the id conventions of combobox, listbox and menu', () => {
    assert.deepStrictEqual(foldkitUiCommands['ClickItem']?.({ id: 'palette', index: 2 }), { click: '#palette-item-2' })
    assert.deepStrictEqual(foldkitUiCommands['ScrollIntoView']?.({ id: 'palette', index: 2 }), {
      scrollIntoView: '#palette-item-2',
    })
    assert.deepStrictEqual(foldkitUiCommands['FocusInput']?.({ id: 'palette' }), { focus: '#palette-input' })
    assert.deepStrictEqual(foldkitUiCommands['FocusButton']?.({ id: 'menu' }), { focus: '#menu-button' })
    assert.deepStrictEqual(foldkitUiCommands['FocusItems']?.({ id: 'menu' }), { focus: '#menu-items' })
    // Other arguments: not forwarded, the Command runs as usual.
    assert.isUndefined(foldkitUiCommands['ClickItem']?.({ selector: '#x' }))
  })
})

describe('handlers at event time', () => {
  it.effect('may call view code, as crease menus do when resolving their items', () =>
    Effect.gen(function* () {
      let rendersItems = 0
      const program: Program<number, Message, Message> = {
        name: 'handlers',
        /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
        ClientMessage: ClientMessage as unknown as S.Codec<Message, unknown, never, never>,
        flags: () => Effect.void,
        Model: S.Number,
        init: () => ({ model: 0 }),
        update: (count, message) => ({ model: message._tag === 'PressedCreate' ? count + 1 : count }),
        view: (count: number, h: HtmlBuilder<Message>) => ({
          title: String(count),
          body: h.main(
            [],
            [
              h.button(
                [
                  h.Id('menu'),
                  h.OnKeyDownPreventDefault(key => {
                    // Builds markup to decide, like resolving a menu's item configs.
                    rendersItems += h.span([], ['item']) === undefined ? 0 : 1
                    return key === 'ArrowDown' ? Option.some(Message.PressedCreate()) : Option.none()
                  }),
                ],
                ['menu'],
              ),
            ],
          ),
        }),
      }
      const session = yield* Session.make(program, 'handlers', { model: 0, firstSequence: 1 })
      const { html } = yield* session.render
      const handlerId = html.match(/h: '([^']+)'/)?.[1] ?? ''
      yield* session.receive({ h: handlerId, k: 'ArrowDown', s: false, c: false, a: false, mt: false, q: 1 })
      assert.strictEqual(session.applied().model, 1)
      assert.isAbove(rendersItems, 0)
      yield* session.close
    }),
  )
})

describe('key bindings with a function Message', () => {
  it.effect('post the focused element id to a session handler', () =>
    Effect.gen(function* () {
      const Submitted = defineMessageUnion({ Submitted: { targetId: S.String } })
      type Submitted = typeof Submitted.Type
      const program: Program<string, Submitted, never> = {
        name: 'keys-function',
        Model: S.String,
        /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
        ClientMessage: S.Never as unknown as S.Codec<never, unknown, never, never>,
        flags: () => Effect.void,
        init: () => ({ model: '' }),
        update: (_, message) => ({ model: message.targetId }),
        view: (_: string, h: HtmlBuilder<Submitted>) => ({
          title: 'keys',
          body: h.main(
            [],
            [keyBindings(h, [{ keys: 'Mod+Enter', whileTyping: 'Allow', message: ({ targetId }) => Submitted.Submitted({ targetId }) }])],
          ),
        }),
      }
      const session = yield* Session.make(program, 'keys-function', { model: '', firstSequence: 1 })
      const { html } = yield* session.render
      const binding = tableOf(html).b[0]
      assert.isTrue(binding.v)
      assert.match(binding.x, /^h: '/)
      // The page script sends the focused element's id and the id a local
      // `select` effect moved to (none here) as `x`.
      yield* session.receive({ h: fieldOf(binding.x), x: ['comment-input', ''], q: 1 })
      assert.strictEqual(session.applied().model, 'comment-input')
      yield* session.close
    }),
  )
})

describe('key bindings in a region', () => {
  it.live('keep their markup across renders, handler ids aside', () =>
    Effect.gen(function* () {
      const Pressed = defineMessageUnion({ Pressed: { targetId: S.String }, Bumped: {} })
      type Pressed = typeof Pressed.Type
      const program: Program<number, Pressed, never> = {
        name: 'keys-region',
        Model: S.Number,
        /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
        ClientMessage: S.Never as unknown as S.Codec<never, unknown, never, never>,
        flags: () => Effect.void,
        init: () => ({ model: 0 }),
        update: (count, message) => ({ model: message._tag === 'Bumped' ? count + 1 : count }),
        view: (count: number, h: HtmlBuilder<Pressed>) => ({
          title: String(count),
          body: h.main(
            [],
            [
              h.p([], [String(count)]),
              region(h, {
                id: 'keys',
                deps: [],
                render: () =>
                  h.div([h.Id('keys')], [keyBindings(h, [{ keys: 'J', message: ({ targetId }) => Pressed.Pressed({ targetId }) }])]),
              }),
            ],
          ),
        }),
      }
      const session = yield* Session.make(program, 'keys-region', { model: 0, firstSequence: 1 })
      const first = yield* session.render
      yield* session.dispatch(Pressed.Bumped())
      yield* Effect.sleep('20 millis')
      // Outside production the kept region is rendered again and compared.
      const second = yield* session.render
      assert.strictEqual(second.regions.get('keys')?.version, first.regions.get('keys')?.version)
      yield* session.close
    }),
  )
})
