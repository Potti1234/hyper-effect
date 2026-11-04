import { Option } from 'effect'

import { LOCAL, LOCAL_ATTRIBUTE, eventOfBinding } from './local.ts'
import type {
  Attribute,
  ChildAttribute,
  HtmlBuilder,
  KeyboardModifiers,
} from 'foldkit/html'

/* Translates Foldkit event attributes into Datastar `data-on:*` attributes.
   Foldkit attributes are plain tagged data until an element is built, so the
   server builder can rewrite them before Foldkit's own element factory runs.

   Two encodings:
   - Message-valued handlers (`OnClick(msg)`) carry the Schema-encoded Message
     as a token. They survive a lost session because the server can decode them
     without any render state.
   - Function-valued handlers (`OnInput(value => msg)`) cannot leave the
     server, so they are registered in the session's handler table and the
     browser posts the handler id plus the event data.

   Every post carries `q`, a per-page sequence number kept in the `_hq` signal,
   so the session applies events in the order the user produced them even when
   requests overtake each other. Requests are never cancelled: a Message must
   not be dropped, and a dropped request would leave a gap in the sequence.

   Inputs whose value is sent to the server as the user types are client-owned:
   a morph must never write an older echo of the value back over newer typing.
   They get `data-preserve-attr="value"` plus a `data-bind` signal, and the
   session patches that signal only when the Model diverges from what the
   client last sent (for example clearing the field after a save).

   Strings that end up inside a Datastar expression (focus selectors, text to
   copy) are base64url-encoded: Datastar reads `$name` and `@action(` as code
   even inside string literals. */

export type Handler<Message> =
  | Readonly<{
      _tag: 'Value'
      f: (value: string) => Message
      /** Set when the handler belongs to a client-owned input. */
      inputId?: string
    }>
  | Readonly<{
      _tag: 'Key'
      f: (key: string, modifiers: KeyboardModifiers) => Option.Option<Message>
    }>
  | Readonly<{ _tag: 'Number'; f: (value: number) => Message }>
  | Readonly<{
      _tag: 'Custom'
      name: string
      f: (event: CustomEvent<unknown>) => Option.Option<Message>
    }>
  /** Event data posted as an array (pointer and beforeinput events). */
  | Readonly<{ _tag: 'Args'; f: (args: ReadonlyArray<unknown>) => Option.Option<Message> }>
  /** A constant Message that is not JSON-encodable, so it cannot be a token. */
  | Readonly<{ _tag: 'Message'; message: Message }>
  /** Files chosen or dropped, uploaded to the session (`OnFileChange`,
   *  `OnDropFiles`). */
  | Readonly<{ _tag: 'Files'; f: (files: ReadonlyArray<File>) => Message }>

export interface Binder<Message> {
  /** Path the browser posts events to. */
  readonly endpoint: string
  /** Binds a Message-valued event: returns the payload fields to post
   *  (`m: '<token>'`, or `h: '<id>'` for a Message that is not
   *  JSON-encodable). Throws for Messages outside `ClientMessage`. */
  readonly bindMessage: (message: Message) => string
  /** Registers a function-valued handler for this render and returns its id. */
  readonly registerHandler: (handler: Handler<Message>) => string
  /** Registers a client-owned input and the value the Model holds for it. */
  readonly registerInput: (inputId: string, value: string) => void
}

/** Maps a child binder's Messages into the parent's, for `h.submodel`. */
export const mapBinder = <Child, Parent>(
  parent: Binder<Parent>,
  toParent: (message: Child) => Parent,
): Binder<Child> => ({
  endpoint: parent.endpoint,
  bindMessage: message => parent.bindMessage(toParent(message)),
  registerHandler: handler => parent.registerHandler(mapHandler(handler, toParent)),
  registerInput: parent.registerInput,
})

const mapHandler = <Child, Parent>(
  handler: Handler<Child>,
  toParent: (message: Child) => Parent,
): Handler<Parent> => {
  switch (handler._tag) {
    case 'Value': {
      const f = (value: string) => toParent(handler.f(value))
      return handler.inputId === undefined
        ? { _tag: 'Value', f }
        : { _tag: 'Value', f, inputId: handler.inputId }
    }
    case 'Number':
      return { _tag: 'Number', f: (value: number) => toParent(handler.f(value)) }
    case 'Key':
      return {
        _tag: 'Key',
        f: (key: string, modifiers: KeyboardModifiers) =>
          Option.map(handler.f(key, modifiers), toParent),
      }
    case 'Custom':
      return {
        _tag: 'Custom',
        name: handler.name,
        f: (event: CustomEvent<unknown>) => Option.map(handler.f(event), toParent),
      }
    case 'Args':
      return {
        _tag: 'Args',
        f: (args: ReadonlyArray<unknown>) => Option.map(handler.f(args), toParent),
      }
    case 'Message':
      return { _tag: 'Message', message: toParent(handler.message) }
    case 'Files':
      return { _tag: 'Files', f: (files: ReadonlyArray<File>) => toParent(handler.f(files)) }
  }
}

/** Signal backing a client-owned input. Datastar camel-cases the attribute
 *  key, so `data-bind:_hv-name` binds the signal `_hvName`. The leading
 *  underscore keeps it out of requests. */
export const inputSignal = (inputId: string) => {
  const slug = inputId.toLowerCase().replace(/[^a-z0-9]/g, '')
  return {
    key: `_hv-${slug}`,
    name: `_hv${slug.charAt(0).toUpperCase()}${slug.slice(1)}`,
  }
}

/** Signal holding the page's event sequence number. */
export const SEQUENCE_SIGNAL = '_hq'

/** Signal holding the session's event endpoint. Keeping the session id out
 *  of every binding makes markup that binds only Messages identical across
 *  sessions, so it can be rendered once and shared (see `shared.ts`). */
export const ENDPOINT_SIGNAL = '_he'

/** Page-script functions the bindings call (see `server.ts`). */
export const PENDING_INPUTS = 'hyperPendingInputs'
export const FRESH_VALUE = 'hyperFreshValue'
export const FOCUS = 'hyperFocus'
/** Page script function that uploads files to the session. */
export const UPLOAD = 'hyperUpload'
/** Path of a session's upload endpoint, below its event endpoint. */
export const UPLOAD_PATH = '/upload'
export const FOCUS_KEY = 'hyperFocusKey'
export const COPY_TEXT = 'hyperCopyText'
/** Page script function matching key bindings (`keys.ts`). */
export const KEYS = 'hyperKeys'

/** Marks a client-owned input with its value handler id. */
export const INPUT_HANDLER_ATTRIBUTE = 'data-hyper-input'

export class UnsupportedEventError extends Error {
  constructor(readonly tag: string) {
    super(
      `hyper-effect: the Foldkit event attribute "${tag}" has no server binding. ` +
        'Render this part as a Foldkit island or use a supported event.',
    )
  }
}

/** A value embedded in an expression, decoded by the page script. */
const literal = (value: unknown): string =>
  `'${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}'`

type MessageEvent = Readonly<{
  event: string
  modifiers?: string
  /** Expression that must hold for the event to post. */
  guard?: string
}>

const THROTTLE = '__throttle.100ms'
const LEAVES_ELEMENT = '!el.contains(evt.relatedTarget)'

const MESSAGE_EVENTS: Readonly<Record<string, MessageEvent>> = {
  OnClick: { event: 'click' },
  OnDoubleClick: { event: 'dblclick' },
  OnMouseDown: { event: 'mousedown' },
  OnMouseUp: { event: 'mouseup' },
  OnMouseEnter: { event: 'mouseenter' },
  OnMouseLeave: { event: 'mouseleave' },
  OnMouseOver: { event: 'mouseover' },
  OnMouseOut: { event: 'mouseout' },
  OnMouseMove: { event: 'mousemove', modifiers: THROTTLE },
  OnFocus: { event: 'focus' },
  OnBlur: { event: 'blur' },
  OnFocusEnter: { event: 'focusin', guard: LEAVES_ELEMENT },
  OnFocusLeave: { event: 'focusout', guard: LEAVES_ELEMENT },
  OnSubmit: { event: 'submit', modifiers: '__prevent' },
  OnReset: { event: 'reset' },
  OnWheel: { event: 'wheel', modifiers: THROTTLE },
  OnCopy: { event: 'copy' },
  OnCut: { event: 'cut' },
  OnPaste: { event: 'paste' },
  OnCancel: { event: 'cancel' },
  OnContextMenu: { event: 'contextmenu' },
  OnDragStart: { event: 'dragstart' },
  OnDrag: { event: 'drag', modifiers: THROTTLE },
  OnDragEnd: { event: 'dragend' },
  OnDragEnter: { event: 'dragenter' },
  OnDragLeave: { event: 'dragleave' },
  OnDragOver: { event: 'dragover', modifiers: THROTTLE },
  OnDrop: { event: 'drop', modifiers: '__prevent' },
  OnTouchStart: { event: 'touchstart' },
  OnTouchEnd: { event: 'touchend' },
  OnTouchMove: { event: 'touchmove', modifiers: THROTTLE },
  OnTouchCancel: { event: 'touchcancel' },
  OnAnimationStart: { event: 'animationstart' },
  OnAnimationEnd: { event: 'animationend' },
  OnAnimationIteration: { event: 'animationiteration' },
  OnTransitionEnd: { event: 'transitionend' },
  OnLoad: { event: 'load' },
  OnError: { event: 'error' },
  OnPlay: { event: 'play' },
  OnPause: { event: 'pause' },
  OnEnded: { event: 'ended' },
  OnSelect: { event: 'select' },
}

const VALUE_EVENTS: Readonly<Record<string, string>> = {
  OnInput: 'input',
  OnChange: 'change',
}

/** Keyboard handlers returning a Message for every key. */
const KEY_EVENTS: Readonly<Record<string, string>> = {
  OnKeyDown: 'keydown',
  OnKeyDownSelf: 'keydown',
  OnKeyUp: 'keyup',
  OnKeyPress: 'keypress',
}

/** Keyboard handlers returning `Option<Message>` and preventing the default
 *  for the keys they handle. The browser cannot ask the server synchronously,
 *  but views are pure, so the handler is probed at render time with every
 *  common key; the page listens for exactly the keys that produced a Message. */
const KEY_OPTION_EVENTS: Readonly<Record<string, string>> = {
  OnKeyDownPreventDefault: 'keydown',
  OnKeyDownSelfPreventDefault: 'keydown',
  OnKeyUpPreventDefault: 'keyup',
}

/** File events: the files are uploaded as multipart, not posted as JSON. The
 *  sequence number is taken here, so an upload keeps its place among the
 *  page's events. */
const FILE_EVENTS: Readonly<Record<string, Readonly<{ event: string; files: string }>>> = {
  OnFileChange: { event: 'change', files: 'evt.target.files' },
  OnDropFiles: { event: 'drop__prevent', files: 'evt.dataTransfer?.files' },
}

/** Pointer events, posted with their data as an argument array. The array
 *  layout is the same for all; each handler picks its own arguments. */
const POINTER_ARGS =
  'x: [evt.pointerType, evt.button, evt.screenX, evt.screenY, evt.timeStamp, evt.clientX, evt.clientY, evt.pointerId]'

type PointerData = readonly [string, number, number, number, number, number, number, number]

const POINTER_EVENTS: Readonly<
  Record<
    string,
    Readonly<{
      event: string
      modifiers?: string
      call: (f: (...args: ReadonlyArray<unknown>) => unknown, data: PointerData) => unknown
    }>
  >
> = {
  OnPointerDown: {
    event: 'pointerdown',
    call: (f, [type, button, screenX, screenY, time, clientX, clientY, id]) =>
      f(type, button, screenX, screenY, time, clientX, clientY, id, null),
  },
  OnPointerUp: {
    event: 'pointerup',
    call: (f, [type, , screenX, screenY, time]) => f(screenX, screenY, type, time),
  },
  OnPointerMove: {
    event: 'pointermove',
    modifiers: '__throttle.50ms',
    call: (f, [type, , screenX, screenY]) => f(screenX, screenY, type),
  },
  OnPointerLeave: {
    event: 'pointerleave',
    call: (f, [type]) => f(type),
  },
}

const PROBED_KEYS: ReadonlyArray<string> = [
  'Enter',
  'Escape',
  ' ',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Backspace',
  'Delete',
  // Printable ASCII, except characters Datastar treats as expression syntax.
  ...Array.from({ length: 94 }, (_, index) => String.fromCharCode(33 + index)).filter(
    key => key !== '$' && key !== '@',
  ),
]

const NO_MODIFIERS: KeyboardModifiers = {
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
}

const INPUT_DEBOUNCE = '__debounce.200ms'
const SCROLL_THROTTLE = '__throttle.150ms'

type ClickOptions = Readonly<{
  defaultAction?: 'Allow' | 'Prevent'
  propagation?: 'Bubble' | 'Stop'
}>

const clickModifiers = (options: ClickOptions | undefined): string =>
  (options?.defaultAction === 'Prevent' ? '__prevent' : '') +
  (options?.propagation === 'Stop' ? '__stop' : '')

/** Every post also carries `p`: values typed into client-owned inputs whose
 *  debounced post has not gone out yet (collected by the page script), so a
 *  submit can never overtake the last keystrokes. */
const post = (payload: string): string =>
  `@post($${ENDPOINT_SIGNAL}, {payload: {${payload}, q: ++$${SEQUENCE_SIGNAL}, p: window.${PENDING_INPUTS}?.() ?? {}}, requestCancellation: 'disabled'})`

const KEY_PAYLOAD =
  'k: evt.key, s: evt.shiftKey, c: evt.ctrlKey, a: evt.altKey, mt: evt.metaKey'

type AnyAttribute<Message> = Attribute<Message> | ChildAttribute

const CHILD_ATTRIBUTE_BRAND = '__childAttribute'

const tagOf = (attribute: unknown): string | undefined =>
  typeof attribute === 'object' && attribute !== null && '_tag' in attribute
    ? String(attribute._tag)
    : undefined

const valueOf = <Message>(
  attributes: ReadonlyArray<AnyAttribute<Message>>,
  tag: string,
): string | undefined => {
  const found = attributes.find(attribute => tagOf(attribute) === tag)
  /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
  return found === undefined ? undefined : (found as unknown as { value: string }).value
}

/** Rewrites one element's attributes. */
export const rewriteAttributes = <Message>(
  attributes: ReadonlyArray<AnyAttribute<Message>>,
  binder: Binder<Message>,
  h: HtmlBuilder<Message>,
  rootBinder: Binder<unknown> = binder as Binder<unknown>,
): ReadonlyArray<AnyAttribute<Message>> => {
  const id = valueOf(attributes, 'Id')
  const value = valueOf(attributes, 'Value')
  const sendsValue = attributes.some(attribute => {
    const tag = tagOf(attribute)
    return tag !== undefined && tag in VALUE_EVENTS
  })
  const inputId =
    id !== undefined && value !== undefined && sendsValue ? id : undefined

  // Remember the id of the input's value handler, for the pending-input flush.
  let valueHandlerId: string | undefined
  const elementBinder: Binder<Message> =
    inputId === undefined
      ? binder
      : {
          ...binder,
          registerHandler: handler => {
            const handlerId = binder.registerHandler(handler)
            if (handler._tag === 'Value') valueHandlerId ??= handlerId
            return handlerId
          },
        }

  const rewritten = withLocalEffects(
    attributes,
    attributes.map(attribute => rewriteAttribute(attribute, elementBinder, h, inputId, rootBinder)),
    h,
  )
  if (inputId === undefined || value === undefined) {
    return rewritten
  }
  binder.registerInput(inputId, value)
  return [
    ...rewritten,
    h.Attribute(`data-bind:${inputSignal(inputId).key}`, ''),
    h.Attribute('data-preserve-attr', 'value'),
    ...(valueHandlerId === undefined
      ? []
      : [h.Attribute(INPUT_HANDLER_ATTRIBUTE, valueHandlerId)]),
  ]
}

/** An element with local effects (`local.ts`): each binding of an event that
 *  has effects runs them first, with the sequence number its post takes. */
const withLocalEffects = <Message>(
  original: ReadonlyArray<AnyAttribute<Message>>,
  rewritten: ReadonlyArray<AnyAttribute<Message>>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<AnyAttribute<Message>> => {
  const declared = original.find(
    attribute => tagOf(attribute) === 'Attribute' && keyOf(attribute) === LOCAL_ATTRIBUTE,
  )
  if (declared === undefined) return rewritten
  /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
  const events = Object.keys(JSON.parse((declared as unknown as { value: string }).value) as object)
  return rewritten.map(attribute => {
    const key = tagOf(attribute) === 'Attribute' ? keyOf(attribute) : undefined
    const event = key === undefined ? undefined : eventOfBinding(key)
    if (key === undefined || event === undefined || !events.includes(event)) return attribute
    /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
    const expression = (attribute as unknown as { value: string }).value
    return h.Attribute(key, `(window.${LOCAL}?.(el, evt, $${SEQUENCE_SIGNAL} + 1), ${expression})`)
  })
}

const keyOf = (attribute: unknown): string | undefined =>
  typeof attribute === 'object' && attribute !== null && 'key' in attribute
    ? String(attribute.key)
    : undefined

/** Lifecycle hooks that only exist in a browser runtime (focus management,
 *  measuring, third-party widgets). The server drops them; a widget that
 *  depends on them belongs in an island. */
const BROWSER_ONLY = new Set(['OnMount', 'OnUnmount'])
const warnedBrowserOnly = new Set<string>()

const dropBrowserOnly = <Message>(tag: string, h: HtmlBuilder<Message>): Attribute<Message> => {
  if (!warnedBrowserOnly.has(tag)) {
    warnedBrowserOnly.add(tag)
    console.warn(
      `hyper-effect: dropped ${tag}; it needs a browser runtime. Use an island where it matters.`,
    )
  }
  return h.Attribute('data-hyper-dropped', tag)
}

/** Applies a ChildAttribute's `toParentMessage` chain (innermost first) to
 *  whatever its event attribute produces, giving an attribute in the root
 *  Message universe. */
const liftToRoot = (
  attribute: Readonly<Record<string, unknown>>,
  mappers: ReadonlyArray<(message: unknown) => unknown>,
): Readonly<Record<string, unknown>> => {
  const lift = (message: unknown) => mappers.reduce((current, toParent) => toParent(current), message)
  // OnKeyDownFocus produces `{ focusSelector, message }`; lift the message.
  const liftValue = (value: unknown) =>
    attribute['_tag'] === 'OnKeyDownFocus' && typeof value === 'object' && value !== null
      ? { ...value, message: lift((value as { message: unknown }).message) }
      : lift(value)
  const liftResult = (result: unknown) =>
    Option.isOption(result) ? Option.map(result, liftValue) : lift(result)
  const f = attribute['f']
  const maybeCustom = attribute['maybeCustomEventMessage']
  return {
    ...attribute,
    ...('message' in attribute ? { message: lift(attribute['message']) } : {}),
    ...(Option.isOption(maybeCustom) ? { maybeCustomEventMessage: Option.map(maybeCustom, lift) } : {}),
    ...(typeof f === 'function'
      ? { f: (...args: ReadonlyArray<unknown>) => liftResult(f(...args)) }
      : {}),
  }
}

export const rewriteAttribute = <Message>(
  attribute: AnyAttribute<Message>,
  binder: Binder<Message>,
  h: HtmlBuilder<Message>,
  inputId?: string,
  rootBinder: Binder<unknown> = binder as Binder<unknown>,
): AnyAttribute<Message> => {
  if (typeof attribute === 'object' && attribute !== null && CHILD_ATTRIBUTE_BRAND in attribute) {
    // A Submodel's attribute placed on an element its parent builds. Its
    // Message is the child's; lift it to the root and bind it there.
    const inner = tagOf(attribute.attribute)
    if (inner === undefined || !(inner.startsWith('On') || inner === 'AllowDrop')) {
      /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
      return attribute.attribute as Attribute<Message>
    }
    if (BROWSER_ONLY.has(inner)) {
      return dropBrowserOnly(inner, h)
    }
    const lifted = liftToRoot(
      /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
      attribute.attribute as Readonly<Record<string, unknown>>,
      attribute.boundaryMappers,
    )
    /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
    return rewriteAttribute(
      lifted as unknown as Attribute<unknown>,
      rootBinder,
      h as HtmlBuilder<unknown>,
      inputId,
    ) as AnyAttribute<Message>
  }

  const tag = tagOf(attribute)
  if (tag === 'AllowDrop') {
    return h.Attribute('data-on:dragover__prevent', 'void 0')
  }
  if (tag === undefined || !tag.startsWith('On')) {
    return attribute
  }
  if (BROWSER_ONLY.has(tag)) {
    return dropBrowserOnly(tag, h)
  }
  /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
  const event = attribute as unknown as Readonly<{
    message?: Message
    options?: ClickOptions
    name?: string
    text?: string
    focusSelector?: string
    maybeCustomEventMessage?: Option.Option<Message>
    f?: (...args: ReadonlyArray<never>) => unknown
  }>
  const bindEvent = (name: string, expression: string) => h.Attribute(`data-on:${name}`, expression)

  const messageEvent = MESSAGE_EVENTS[tag]
  if (messageEvent !== undefined && event.message !== undefined) {
    const modifiers =
      tag === 'OnClick' ? clickModifiers(event.options) : (messageEvent.modifiers ?? '')
    const guard = messageEvent.guard === undefined ? '' : `${messageEvent.guard} && `
    return bindEvent(
      `${messageEvent.event}${modifiers}`,
      `${guard}${post(binder.bindMessage(event.message))}`,
    )
  }

  if (tag === 'OnCancelPreventDefault' && event.maybeCustomEventMessage !== undefined) {
    return bindEvent(
      'cancel__prevent',
      Option.match(event.maybeCustomEventMessage, {
        onNone: () => 'void 0',
        onSome: message => post(binder.bindMessage(message)),
      }),
    )
  }

  if (tag === 'OnClickFocus' && event.message !== undefined && event.focusSelector !== undefined) {
    return bindEvent(
      'click',
      `(window.${FOCUS}?.(${literal(event.focusSelector)}), ${post(binder.bindMessage(event.message))})`,
    )
  }

  if (tag === 'OnCopyText' && event.text !== undefined) {
    return bindEvent('copy', `window.${COPY_TEXT}?.(evt, ${literal(event.text)})`)
  }

  if (tag === 'OnCutText' && event.text !== undefined && event.message !== undefined) {
    return bindEvent(
      'cut',
      `(window.${COPY_TEXT}?.(evt, ${literal(event.text)}), ${post(binder.bindMessage(event.message))})`,
    )
  }

  if (event.f === undefined) {
    throw new UnsupportedEventError(tag)
  }

  const valueEvent = VALUE_EVENTS[tag]
  if (valueEvent !== undefined) {
    /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
    const f = event.f as (value: string) => Message
    const id = binder.registerHandler(
      inputId === undefined ? { _tag: 'Value', f } : { _tag: 'Value', f, inputId },
    )
    return bindEvent(
      `${valueEvent}${tag === 'OnInput' ? INPUT_DEBOUNCE : ''}`,
      // A value that already went out with another event (see `p`) is not
      // sent again: a late duplicate would undo what the server did since.
      `window.${FRESH_VALUE}?.(el) !== false && ${post(`h: '${id}', v: evt.target.value`)}`,
    )
  }

  const keyEvent = KEY_EVENTS[tag]
  if (keyEvent !== undefined) {
    /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
    const f = event.f as (key: string, modifiers: KeyboardModifiers) => Message
    const id = binder.registerHandler({
      _tag: 'Key',
      f: (key, modifiers) => Option.some(f(key, modifiers)),
    })
    const self = tag === 'OnKeyDownSelf' ? 'evt.target === el && ' : ''
    return bindEvent(keyEvent, `${self}${post(`h: '${id}', ${KEY_PAYLOAD}`)}`)
  }

  const keyOptionEvent = KEY_OPTION_EVENTS[tag]
  if (keyOptionEvent !== undefined) {
    /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
    const f = event.f as (
      key: string,
      modifiers: KeyboardModifiers,
    ) => Option.Option<Message>
    const keys = PROBED_KEYS.filter(key => Option.isSome(f(key, NO_MODIFIERS)))
    if (keys.length === 0) {
      return h.Attribute('data-hyper-no-keys', '')
    }
    const id = binder.registerHandler({ _tag: 'Key', f })
    const self = tag === 'OnKeyDownSelfPreventDefault' ? 'evt.target === el && ' : ''
    return bindEvent(
      keyOptionEvent,
      `${self}${JSON.stringify(keys)}.includes(evt.key) && (evt.preventDefault(), ${post(
        `h: '${id}', ${KEY_PAYLOAD}`,
      )})`,
    )
  }

  if (tag === 'OnKeyDownFocus') {
    // Probing also yields where focus goes for each key, so the browser moves
    // focus at once and the server only learns the Message.
    /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
    const f = event.f as (
      key: string,
      modifiers: KeyboardModifiers,
    ) => Option.Option<Readonly<{ focusSelector: string; message: Message }>>
    const targets: Record<string, string> = {}
    for (const key of PROBED_KEYS) {
      const result = f(key, NO_MODIFIERS)
      if (Option.isSome(result)) targets[key] = result.value.focusSelector
    }
    if (Object.keys(targets).length === 0) {
      return h.Attribute('data-hyper-no-keys', '')
    }
    const id = binder.registerHandler({
      _tag: 'Key',
      f: (key, modifiers) => Option.map(f(key, modifiers), result => result.message),
    })
    return bindEvent(
      'keydown',
      `window.${FOCUS_KEY}?.(evt, ${literal(targets)}) && ${post(`h: '${id}', ${KEY_PAYLOAD}`)}`,
    )
  }

  const pointerEvent = POINTER_EVENTS[tag]
  if (pointerEvent !== undefined) {
    /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
    const f = event.f as (...args: ReadonlyArray<unknown>) => Option.Option<Message>
    const id = binder.registerHandler({
      _tag: 'Args',
      /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
      f: args => pointerEvent.call(f, args as unknown as PointerData) as Option.Option<Message>,
    })
    return bindEvent(
      `${pointerEvent.event}${pointerEvent.modifiers ?? ''}`,
      post(`h: '${id}', ${POINTER_ARGS}`),
    )
  }

  if (tag === 'OnBeforeInput') {
    /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
    const f = event.f as (inputType: string, data: Option.Option<string>) => Message
    const id = binder.registerHandler({
      _tag: 'Args',
      f: ([inputType, data]) =>
        Option.some(f(String(inputType), Option.fromNullishOr(data as string | null | undefined))),
    })
    return bindEvent('beforeinput', post(`h: '${id}', x: [evt.inputType, evt.data]`))
  }

  if (tag === 'OnToggle') {
    /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
    const f = event.f as (isOpen: boolean) => Message
    const id = binder.registerHandler({ _tag: 'Number', f: value => f(value === 1) })
    return bindEvent('toggle', post(`h: '${id}', n: el.open ? 1 : 0`))
  }

  if (tag === 'OnScroll') {
    /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
    const f = event.f as (scrollTop: number) => Message
    const id = binder.registerHandler({ _tag: 'Number', f })
    return bindEvent(`scroll${SCROLL_THROTTLE}`, post(`h: '${id}', n: el.scrollTop`))
  }

  const fileEvent = FILE_EVENTS[tag]
  if (fileEvent !== undefined) {
    /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
    const f = event.f as (files: ReadonlyArray<File>) => Message
    const id = binder.registerHandler({ _tag: 'Files', f })
    return bindEvent(
      fileEvent.event,
      // The handler id is written `h: '<id>'`, as in every other binding.
      `window.${UPLOAD}?.(el, ${fileEvent.files}, {h: '${id}'}, ++$${SEQUENCE_SIGNAL}, $${ENDPOINT_SIGNAL})`,
    )
  }

  if (tag === 'OnCustomEvent' && event.name !== undefined) {
    /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
    const f = event.f as (event: CustomEvent<unknown>) => Option.Option<Message>
    const id = binder.registerHandler({ _tag: 'Custom', name: event.name, f })
    return bindEvent(event.name, post(`h: '${id}', d: evt.detail`))
  }

  throw new UnsupportedEventError(tag)
}
