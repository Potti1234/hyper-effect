import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, Option, Schema as S } from 'effect'
import type { HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import * as Submodel from 'foldkit/submodel'

import type { Binder, Handler } from '../src/binding'
import { assertNoDroppedHandlers } from '../src/builder'
import type { Program } from '../src/program'
import { renderModel } from '../src/session'

import { ClientMessage, Message, type Model, program } from './fixtures/greeter'

const recordingBinder = () => {
  const handlers: Array<Handler<Message>> = []
  const inputs = new Map<string, string>()
  const encode = S.encodeUnknownSync(ClientMessage)
  const binder: Binder<Message> = {
    endpoint: '/_hyper/test/s/1',
    bindMessage: message => `m: '${JSON.stringify(encode(message))}'`,
    registerHandler: handler => {
      handlers.push(handler)
      return `h${handlers.length - 1}`
    },
    registerInput: (inputId, value) => {
      inputs.set(inputId, value)
    },
  }
  return { binder, handlers, inputs }
}

const viewProgram = (
  view: (model: Model, h: HtmlBuilder<Message>) => ReturnType<typeof program.view>,
): Program<Model, Message, ClientMessage> => ({ ...program, view })

const model = program.init().model

describe('server builder', () => {
  it.effect('renders Foldkit views with Datastar bindings', () =>
    Effect.gen(function* () {
      const { binder } = recordingBinder()
      const { html, title } = yield* renderModel(program, model, binder)

      assert.strictEqual(title, 'hyper-effect (0)')
      assert.include(html, 'id="hyper-root"')
      assert.include(html, 'aria-label="Increment"')
      // Message-valued handlers carry the encoded Message, a sequence number,
      // and are never cancelled
      assert.include(html, 'data-on:click=')
      assert.include(html, '{&quot;_tag&quot;:&quot;ClickedIncrement&quot;}')
      assert.include(html, 'q: ++$_hq')
      assert.include(html, "requestCancellation: 'disabled'")
      // submit is prevented and posted
      assert.include(html, 'data-on:submit__prevent=')
      // OnInput is debounced and refers to a handler id
      assert.include(html, 'data-on:input__debounce.200ms=')
      assert.include(html, 'v: evt.target.value')
      // the input is client-owned: morphs keep its value, a signal can set it
      assert.include(html, 'data-bind:_hv-name=""')
      assert.include(html, 'data-preserve-attr="value"')
      // nothing Foldkit would have attached as a DOM listener remains
      assert.notInclude(html, 'onclick')
    }),
  )

  it.effect('registers function-valued handlers for the session', () =>
    Effect.gen(function* () {
      const { binder, handlers } = recordingBinder()
      yield* renderModel(program, model, binder)

      assert.strictEqual(handlers.length, 1)
      const handler = handlers[0]
      assert.strictEqual(handler?._tag, 'Value')
      if (handler?._tag === 'Value') {
        assert.deepStrictEqual(handler.f('Ada'), Message.ChangedName({ name: 'Ada' }))
      }
    }),
  )

  it.effect('refuses to bind a Message the client may not send', () =>
    Effect.gen(function* () {
      const forging = viewProgram((_, h) => ({
        title: 'forging',
        body: h.button(
          [h.OnClick(Message.SucceededSaveGreeting({ greeting: 'forged' }))],
          ['Forge'],
        ),
      }))
      const exit = yield* Effect.exit(
        renderModel(forging, model, {
          ...recordingBinder().binder,
          bindMessage: message => {
            S.encodeUnknownSync(ClientMessage)(message)
            return 'unreachable'
          },
        }),
      )
      assert.isTrue(Exit.isFailure(exit))
    }),
  )

  it.effect('fails on events without a server binding', () =>
    Effect.gen(function* () {
      const dragging = viewProgram((_, h) => ({
        title: 'drag',
        body: h.input([h.OnPastePreventDefault(() => Option.some(Message.ClickedIncrement()))]),
      }))
      const exit = yield* Effect.exit(
        renderModel(dragging, model, recordingBinder().binder),
      )
      assert.isTrue(Exit.isFailure(exit))
    }),
  )

  it('fails when an element still carries DOM listeners', () => {
    const vnode = { sel: 'button', data: { on: { click: () => {} } }, children: [] }
    /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
    assert.throws(() => assertNoDroppedHandlers(vnode as never), /button \(click\)/)
  })

  it.effect('listens only for the keys a PreventDefault handler handles', () =>
    Effect.gen(function* () {
      const { binder, handlers } = recordingBinder()
      const keys = viewProgram((_, h) => ({
        title: 'keys',
        body: h.div(
          [
            h.OnKeyDownPreventDefault(key =>
              key === 'ArrowUp'
                ? Option.some(Message.ClickedIncrement())
                : key === 'ArrowDown'
                  ? Option.some(Message.ClickedDecrement())
                  : Option.none(),
            ),
          ],
          [],
        ),
      }))
      const { html } = yield* renderModel(keys, model, binder)
      assert.include(html, '[&quot;ArrowUp&quot;,&quot;ArrowDown&quot;].includes(evt.key)')
      assert.include(html, 'evt.preventDefault()')
      const handler = handlers[0]
      assert.strictEqual(handler?._tag, 'Key')
    }),
  )

  it.effect('binds custom events, for islands', () =>
    Effect.gen(function* () {
      const { binder, handlers } = recordingBinder()
      const custom = viewProgram((_, h) => ({
        title: 'custom',
        body: h.div(
          [
            {
              _tag: 'OnCustomEvent',
              name: 'island-event',
              f: (event: CustomEvent<unknown>) =>
                S.decodeUnknownOption(S.Struct({ name: S.String }))(event.detail).pipe(
                  Option.map(Message.ChangedName),
                ),
            },
          ],
          [],
        ),
      }))
      const { html } = yield* renderModel(custom, model, binder)
      assert.include(html, 'data-on:island-event=')
      assert.include(html, 'd: evt.detail')
      const handler = handlers[0]
      assert.strictEqual(handler?._tag, 'Custom')
      if (handler?._tag === 'Custom') {
        assert.deepStrictEqual(
          handler.f(new CustomEvent('island-event', { detail: { name: 'Ada' } })),
          Option.some(Message.ChangedName({ name: 'Ada' })),
        )
      }
    }),
  )
})

describe('submodels', () => {
  const ChildMessage = defineMessageUnion({ ClickedChild: { label: S.String } })
  type ChildMessage = typeof ChildMessage.Type
  const ParentMessage = defineMessageUnion({ GotChildMessage: { message: ChildMessage } })
  type ParentMessage = typeof ParentMessage.Type

  const childView = Submodel.defineView<string, ChildMessage>((label, h) =>
    h.button([h.OnClick(ChildMessage.ClickedChild({ label }))], [label]),
  )

  it.effect('render with their own Message, mapped into the parent', () =>
    Effect.gen(function* () {
      const encode = S.encodeUnknownSync(ParentMessage)
      const binder: Binder<ParentMessage> = {
        endpoint: '/_hyper/test/s/1',
        bindMessage: message => `m: '${JSON.stringify(encode(message))}'`,
        registerHandler: () => 'h0',
        registerInput: () => {},
      }
      const parent: Program<null, ParentMessage, ParentMessage> = {
        name: 'parent',
        Model: S.Null,
        ClientMessage: ParentMessage,
        flags: () => Effect.void,
        init: () => ({ model: null }),
        update: model => ({ model }),
        view: (_, h) => ({
          title: 'parent',
          body: h.submodel({
            slotId: 'child',
            model: 'Child',
            view: childView,
            toParentMessage: message => ParentMessage.GotChildMessage({ message }),
          }),
        }),
      }
      const { html } = yield* renderModel(parent, null, binder)
      assert.include(html, '&quot;GotChildMessage&quot;')
      assert.include(html, '&quot;ClickedChild&quot;')
    }),
  )
})
