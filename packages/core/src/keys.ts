import { Duration, Option } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { type Binder, ENDPOINT_SIGNAL, KEYS, PENDING_INPUTS, SEQUENCE_SIGNAL } from './binding.ts'
import { binderOf } from './builder.ts'
import type { LocalEffect } from './local.ts'

/* Global key bindings: keyboard shortcuts for the whole page, matched in the
   browser.

   Foldkit's `Subscription.keyBindings` listens on `document`, which a server
   session does not have, and an element's own key handlers only see keys
   while it has focus. `keyBindings(h, bindings)` renders a hidden element
   that listens on the window and carries the binding table; the page script
   matches each key press against it with the same rules as Foldkit's helper
   and posts the matching binding's Message. Keys that match nothing never
   leave the browser.

   The table is part of the view, so it follows the Model: a binding with
   `isEnabled: false` is left out, and the next morph updates the table. */

/** One press (`'C'`, `'/'`, `'Mod+K'`, `'Shift+?'`) or a sequence of two or
 *  more (`['G', 'M']`). Foldkit's grammar: modifiers `Mod`, `Control`,
 *  `Meta`, `Alt`, `Shift` joined with `+`; `Mod` is Meta on Apple platforms
 *  and Control elsewhere; keys match `KeyboardEvent.key` case-insensitively
 *  and exactly in their modifiers; `Space` and `Plus` name those keys. */
export type KeySequence = string | Readonly<[string, string, ...Array<string>]>

/** Where the key was pressed, for bindings whose Message depends on it. */
export type KeyContext = Readonly<{
  /** The id of the focused element, or '' when none has one. */
  targetId: string
  /** The id of the item a `select` local effect moved to, or ''. */
  selectedId: string
}>

export type KeyBinding<Message> = Readonly<{
  keys: KeySequence
  /** Posted when the binding matches. A Message must be a ClientMessage; a
   *  function (like Foldkit's `mapEvent`) gets where the key was pressed and
   *  runs in the session, so its Message need not be one. */
  message: Message | ((context: KeyContext) => Message)
  isEnabled?: boolean
  /** 'Suppress' (the default): not while typing in an input, textarea,
   *  select or contenteditable element. */
  whileTyping?: 'Suppress' | 'Allow'
  /** Default true: the matched key's default action is prevented. */
  preventDefault?: boolean
  /** One-press bindings ignore held-down repeats unless 'Allow'. */
  whenRepeated?: 'Ignore' | 'Allow'
  /** Screen-only effects the page applies at once, before posting
   *  (`local.ts`), such as `{ select: { within: '#list', by: 1 } }` for `J`. */
  local?: ReadonlyArray<LocalEffect>
}>

export type KeyBindingsOptions = Readonly<{
  /** The host element's id, unique on the page (several tables may coexist). */
  id?: string
  /** How long a sequence waits for its next press. Default 1 second. */
  sequenceTimeout?: Duration.Input
}>

/** [key, control, meta, alt, shift, mod], as the page script compares it. */
type Press = readonly [string, boolean, boolean, boolean, boolean, boolean]

const MODIFIERS = ['mod', 'control', 'meta', 'alt', 'shift'] as const
const MODIFIER_KEYS = new Set([
  'alt', 'altgraph', 'capslock', 'control', 'fn', 'fnlock', 'hyper', 'meta', 'numlock', 'os',
  'scrolllock', 'shift', 'super', 'symbol', 'symbollock',
])

const parsePress = (press: string): Press => {
  const tokens = press.split('+').map(token => token.trim().toLowerCase())
  const invalid = (reason: string) => new Error(`hyper-effect: invalid key binding "${press}": ${reason}`)
  if (tokens.some(token => token === '')) throw invalid('each modifier and key must be named; use "Plus" for the + key')
  const keyToken = tokens[tokens.length - 1] as string
  const modifiers = tokens.slice(0, -1)
  const key = keyToken === 'space' ? ' ' : keyToken === 'plus' ? '+' : keyToken
  if ((MODIFIERS as ReadonlyArray<string>).includes(keyToken) || MODIFIER_KEYS.has(key)) {
    throw invalid('a non-modifier key is required')
  }
  for (const modifier of modifiers) {
    if (!(MODIFIERS as ReadonlyArray<string>).includes(modifier)) throw invalid(`unknown modifier "${modifier}"`)
  }
  if (new Set(modifiers).size !== modifiers.length) throw invalid('a modifier is repeated')
  const has = (modifier: (typeof MODIFIERS)[number]) => modifiers.includes(modifier)
  if (has('mod') && (has('control') || has('meta'))) throw invalid('Mod already means Control or Meta')
  return [key, has('control'), has('meta'), has('alt'), has('shift'), has('mod')]
}

/** A binding's payload fields as every binding writes them (`m: '<token>'`
 *  or `h: '<id>'`), so a region compares its markup with handler ids aside,
 *  as for any other binding. The page script reads them back. */
const payloadFor = <Message>(binder: Binder<Message>, message: KeyBinding<Message>['message']): string => {
  if (typeof message !== 'function') return binder.bindMessage(message)
  /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
  const toMessage = message as (context: KeyContext) => Message
  const handlerId = binder.registerHandler({
    _tag: 'Args',
    f: ([targetId, selectedId]) =>
      Option.some(toMessage({ targetId: String(targetId ?? ''), selectedId: String(selectedId ?? '') })),
  })
  return `h: '${handlerId}'`
}

/** Renders a page's key bindings. Put it in the view once (or once per
 *  independent table, with distinct ids), outside regions that rarely
 *  change, or in a region whose deps include what the table depends on.
 *
 *  ```ts
 *  keyBindings(h, [
 *    { keys: 'C', message: Message.PressedCreate() },
 *    { keys: 'Mod+K', message: Message.PressedPalette(), whileTyping: 'Allow' },
 *    { keys: ['G', 'M'], message: Message.PressedGoToMyIssues() },
 *    { keys: 'Escape', message: Message.PressedEscape(), isEnabled: model.isPaletteOpen, whileTyping: 'Allow' },
 *  ])
 *  ```
 *
 *  If what a key means depends on the Model, post a factual Message
 *  (`PressedJ`) and decide in update. Outside a live session (a Scene test,
 *  Foldkit's browser runtime) it renders an inert element. */
export const keyBindings = <Message>(
  h: HtmlBuilder<Message>,
  bindings: ReadonlyArray<KeyBinding<Message>>,
  options: KeyBindingsOptions = {},
): Html => {
  const id = options.id ?? 'hyper-keys'
  const binder = binderOf(h)
  const enabled = bindings.filter(binding => binding.isEnabled !== false)
  const table = {
    t: Duration.toMillis(Duration.fromInputUnsafe(options.sequenceTimeout ?? '1 second')),
    b: enabled.map(binding => {
      const presses = typeof binding.keys === 'string' ? [binding.keys] : binding.keys
      return {
        p: presses.map(parsePress),
        w: binding.whileTyping === 'Allow',
        d: binding.preventDefault !== false,
        r: binding.whenRepeated === 'Allow',
        x: binder === undefined ? '' : payloadFor(binder, binding.message),
        v: typeof binding.message === 'function',
        ...(binding.local === undefined || binding.local.length === 0 ? {} : { l: binding.local }),
      }
    }),
  }
  const seen = new Set<string>()
  for (const binding of table.b) {
    const identity = JSON.stringify(binding.p)
    if (seen.has(identity)) throw new Error(`hyper-effect: key binding ${identity} is declared twice`)
    seen.add(identity)
  }
  if (binder === undefined) return h.div([h.Id(id), h.Hidden(true)], [])
  return h.div(
    [
      h.Id(id),
      h.Hidden(true),
      // Plain JSON: Datastar ignores this attribute, and the serializer
      // escapes it.
      h.Attribute('data-hyper-keys', JSON.stringify(table)),
      h.Attribute(
        'data-on:keydown__window',
        `(evt.hyperKey = window.${KEYS}?.(evt, el, $${SEQUENCE_SIGNAL} + 1)) && @post($${ENDPOINT_SIGNAL}, {payload: {...evt.hyperKey, q: ++$${SEQUENCE_SIGNAL}, p: window.${PENDING_INPUTS}?.() ?? {}}, requestCancellation: 'disabled'})`,
      ),
    ],
    [],
  )
}
