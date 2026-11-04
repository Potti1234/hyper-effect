import { assert, describe, it } from '@effect/vitest'
import { Effect, Schema as S } from 'effect'
import * as Command from 'foldkit/command'
import type { HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import { type ClientAction, foldkitUiCommands } from '../src/client-commands'
import { keyBindings } from '../src/keys'
import { local } from '../src/local'
import type { Program } from '../src/program'
import * as Session from '../src/session'

/* Local effects (local.ts) and forwarded Commands with replies
   (client-commands.ts). */

const Message = defineMessageUnion({
  ClickedFilters: {},
  MovedSelection: { selectedId: S.String },
  ClickedOpen: {},
  GotDialog: { tag: S.String },
})
type Message = typeof Message.Type
const ClientMessage = S.Union([Message.ClickedFilters, Message.ClickedOpen])

const DialogResult = defineMessageUnion({ SucceededShowDialog: {}, FailedShowDialog: {} })

const ShowDialog = Command.define('ShowDialog', {
  args: { id: S.String },
  messages: [DialogResult.SucceededShowDialog, DialogResult.FailedShowDialog],
  execute: () => Effect.succeed(DialogResult.FailedShowDialog()),
})

const program: Program<string, Message, Message> = {
  name: 'local',
  Model: S.String,
  /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
  ClientMessage: ClientMessage as unknown as S.Codec<Message, unknown, never, never>,
  flags: () => Effect.void,
  init: () => ({ model: '' }),
  update: (model, message) =>
    Message.match(message, {
      ClickedFilters: () => ({ model: 'filters' }),
      MovedSelection: ({ selectedId }) => ({ model: selectedId }),
      ClickedOpen: () => ({
        model: 'opening',
        commands: [
          Command.mapMessage(ShowDialog({ id: 'settings' }), result => Message.GotDialog({ tag: result._tag })),
        ],
      }),
      GotDialog: ({ tag }) => ({ model: tag }),
    }),
  view: (_: string, h: HtmlBuilder<Message>) => ({
    title: 'local',
    body: h.main(
      [],
      [
        h.button(
          [h.Id('filters-button'), h.OnClick(Message.ClickedFilters()), local(h, { click: [{ toggle: '#filters' }] })],
          ['Filters'],
        ),
        h.button([h.Id('plain'), h.OnClick(Message.ClickedFilters())], ['Plain']),
        keyBindings(h, [
          {
            keys: 'J',
            local: [{ select: { within: '#list', by: 1 } }],
            message: ({ selectedId }) => Message.MovedSelection({ selectedId }),
          },
        ]),
      ],
    ),
  }),
}

const token = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')

const decoded = (html: string) => html.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'")

describe('local effects', () => {
  it.live('run before the post of the bound event, with the sequence number it takes', () =>
    Effect.gen(function* () {
      const session = yield* Session.make(program, 'local', { model: '', firstSequence: 1 })
      const { html } = yield* session.render
      const button = decoded(html.match(/<button[^>]*id="filters-button"[^>]*>/)?.[0] ?? '')
      assert.include(button, 'data-hyper-local="{"click":[{"toggle":"#filters"}]}"')
      assert.include(button, 'data-on:click="(window.hyperLocal?.(el, evt, $_hq + 1), @post(')
      // Elements without local effects keep their plain binding.
      const plain = decoded(html.match(/<button[^>]*id="plain"[^>]*>/)?.[0] ?? '')
      assert.notInclude(plain, 'hyperLocal')
      yield* session.close
    }),
  )

  it.live('give a key binding the id a select effect moved to', () =>
    Effect.gen(function* () {
      const session = yield* Session.make(program, 'local', { model: '', firstSequence: 1 })
      const { html } = yield* session.render
      const encoded = html.match(/data-hyper-keys="([^"]+)"/)?.[1] ?? ''
      const binding = JSON.parse(decoded(encoded)).b[0]
      assert.deepStrictEqual(binding.l, [{ select: { within: '#list', by: 1 } }])
      const handlerId = /h: '([^']+)'/.exec(binding.x)?.[1] ?? ''
      yield* session.receive({ h: handlerId, x: ['', 'row-ENG-7'], q: 1 })
      assert.strictEqual(session.applied().model, 'row-ENG-7')
      yield* session.close
    }),
  )

  it.live('render with the intake position of the Model', () =>
    Effect.gen(function* () {
      const session = yield* Session.make(program, 'local', { model: '', firstSequence: 1 })
      assert.strictEqual((yield* session.render).position, 1)
      yield* session.receive({ m: token(Message.ClickedFilters()), q: 1 })
      const rendered = yield* session.render
      assert.strictEqual(rendered.position, 2)
      assert.strictEqual(session.applied().model, 'filters')
      yield* session.close
    }),
  )
})

describe('forwarded Commands with replies', () => {
  it('map Foldkit UI dialog Commands to page actions and their outcomes', () => {
    assert.deepStrictEqual(foldkitUiCommands['ShowDialog']?.({ id: 'settings', focusSelector: '#name' }), {
      action: { showDialog: '#settings', focus: '#name' },
      replies: { ok: { _tag: 'SucceededShowDialog' }, failed: { _tag: 'FailedShowDialog' } },
    })
    assert.deepStrictEqual(foldkitUiCommands['ReleaseDialogResources']?.({ id: 'settings' }), {
      action: { releaseDialog: 'settings' },
      replies: { ok: { _tag: 'CompletedReleaseDialogResources' } },
    })
  })

  it.live('send the action with a reply id and lift the outcome the page posts', () =>
    Effect.gen(function* () {
      const session = yield* Session.make(program, 'local', { model: '', firstSequence: 1 })
      yield* session.render
      yield* session.receive({ m: token(Message.ClickedOpen()), q: 1 })
      // Commands run once receive has returned: render until the action is there.
      let actions: ReadonlyArray<ClientAction> = []
      for (let attempt = 0; attempt < 50 && actions.length === 0; attempt += 1) {
        yield* Effect.sleep('5 millis')
        actions = (yield* session.render).actions
      }
      assert.strictEqual(actions.length, 1)
      const action = actions[0]
      assert.isTrue(action !== undefined && 'showDialog' in action)
      const replyId = action !== undefined && 'reply' in action ? action.reply : undefined
      assert.isString(replyId)
      // The Command did not run on the server: its Effect would have failed.
      assert.strictEqual(session.applied().model, 'opening')
      yield* session.receive({ r: replyId ?? '', o: 'ok' })
      assert.strictEqual(session.applied().model, 'SucceededShowDialog')
      // An unknown reply id resolves to nothing.
      yield* session.receive({ r: 'r999', o: 'ok' })
      assert.strictEqual(session.applied().model, 'SucceededShowDialog')
      yield* session.close
    }),
  )
})
