import {
  ByteSize,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Queue,
  Redacted,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect'
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  Multipart,
} from 'effect/http'
import { KeyValueStore } from 'effect/persistence'

import {
  COPY_TEXT,
  ENDPOINT_SIGNAL,
  FOCUS,
  FOCUS_KEY,
  FRESH_VALUE,
  KEYS,
  INPUT_HANDLER_ATTRIBUTE,
  PENDING_INPUTS,
  SEQUENCE_SIGNAL,
  UPLOAD,
  UPLOAD_PATH,
} from './binding.ts'
import { DISMISS_EVENT, LOCAL, LOCAL_ATTRIBUTE } from './local.ts'
import * as Compression from './compression.ts'
import { heartbeat, patchElements, patchSignals, runOnce } from './datastar.ts'
import * as Metrics from './metrics.ts'
import { matchPath, type PageRequest, type Program } from './program.ts'
import { sameDeps } from './deps.ts'
import * as Security from './security.ts'
import * as Session from './session.ts'

/** What a request carries for authentication. */
export type RequestContext = Pick<PageRequest, 'cookies' | 'headers' | 'visitorId'>

export type Options<R = never> = Readonly<{
  /** Path pattern of the page, such as `/incidents/:id`. Defaults to `/`. */
  path?: string
  /** More patterns the same program serves. With the program's
   *  `onUrlChange`, the page moves between all of them within one session
   *  (links are taken on mousedown, back and forward work); each is also a
   *  page of its own. */
  paths?: ReadonlyArray<string>
  /** URL patterns (speculation rules `href_matches`, such as `/issue/*`)
   *  whose links the browser may prefetch when the pointer rests on them.
   *  A prefetch (`Sec-Purpose: prefetch`) renders the page without starting
   *  a session: none is left behind when the link is never followed, and the
   *  page's stream starts it from the URL when it is. */
  prefetch?: ReadonlyArray<string>
  /** Stylesheets linked from the page head. */
  stylesheets?: ReadonlyArray<string>
  /** Module scripts loaded by the page, such as an islands bundle. */
  scripts?: ReadonlyArray<string>
  /** Datastar client bundle. */
  datastarUrl?: string
  /** Subresource Integrity hash of `datastarUrl`; built in for the default. */
  datastarIntegrity?: string
  /** How long a session without an open stream is kept. */
  idleTimeout?: Duration.Input
  /** Origins allowed to post events besides the page's own host. */
  allowedOrigins?: ReadonlyArray<string>
  /** Who a request acts for, such as the user id in a verified session
   *  cookie, or undefined for nobody. A session is bound to the principal of
   *  the request that opened it. A later stream or event acting for anyone
   *  else (logged out, switched accounts) closes the session and reloads the
   *  page, so Flags decide again. */
  principal?: (request: RequestContext) => Effect.Effect<string | undefined, never, R>
  /** The page's Content-Security-Policy. On by default, with a per-response
   *  nonce for hyper-effect's inline script and style and the page's
   *  scripts. Add the sources the app loads from elsewhere (map tiles,
   *  fonts); false sends no policy. */
  contentSecurityPolicy?: Security.ContentSecurityPolicy | false
  /** Proxies in front of the server that append to `X-Forwarded-For` and
   *  `X-Forwarded-Host`. With 0, the default, both headers are ignored: the
   *  client address is the socket's, and posts must come from the origin in
   *  the Host header. */
  trustProxy?: number
  /** Names this process when several serve one app (cores or machines):
   *  its session ids start with it (`<node>.<uuid>`), so a router can send a
   *  session's stream and events to the process that holds it (see
   *  `nodeOfPath`). Lowercase letters and digits, at most 16. */
  node?: string
  /** Encrypts snapshots (AES-256-GCM, key derived from the secret), so the
   *  store can neither read Models nor forge them. With a list, the first
   *  secret encrypts and every one decrypts, for rotation. Without one,
   *  snapshots are plain Schema JSON. */
  snapshotSecret?: Security.Secret | ReadonlyArray<Security.Secret>
  /** How long a snapshot can bring its session back. Live sessions refresh
   *  theirs; older ones are discarded. */
  snapshotTtl?: Duration.Input
  /** Answer an event only once its effect is in the snapshot store (the
   *  default). A process that fails then loses no event its page was told
   *  about: the page retries unanswered events, and the process taking over
   *  restores the session with all of them. Events arriving together share
   *  one store write. With false, an event is answered once applied and the
   *  snapshot follows a quiet second later: fewer store writes, but a
   *  failing process loses up to a second of events. */
  durableEvents?: boolean
  /** Compress event streams (gzip), with one compressor per stream flushed
   *  after every patch, so each patch is encoded against the earlier ones:
   *  Dispatch's 5.9 kB region patches travel as about 160 bytes. Off by
   *  default: it keeps about 165 kB per open page, and under a large fan-out
   *  patches leave a little later (see docs/performance.md). Worth it on the
   *  internet, where bytes cost time; a proxy may compress instead. */
  compression?: boolean
  limits?: Partial<Limits>
}>

/** Abuse limits. A session belongs to the browser that opened the page; these
 *  bound what one browser, or one session, can cost the server. */
export type Limits = Readonly<{
  /** Largest event body accepted. */
  maxBodyBytes: number
  /** Sustained events per second per session, and the burst above it. */
  eventsPerSecond: number
  eventBurst: number
  /** Live sessions per visitor; opening more closes their oldest. */
  sessionsPerVisitor: number
  /** Live sessions per program; beyond it pages answer 503. */
  maxSessions: number
  /** A page whose stream never connects (a crawler, a prefetch) is dropped
   *  after this, instead of after the idle timeout. */
  unconnectedTimeout: Duration.Input
  /** Unsent input values one event may carry. */
  maxPendingInputs: number
  /** Sustained pages per second per client address, and the burst above
   *  it. Counts page GETs and sessions recreated after a restart, the two
   *  requests that run Flags. */
  pagesPerSecond: number
  pageBurst: number
  /** Largest upload body (all files of one `OnFileChange`/`OnDropFiles`),
   *  and the most files it may carry. Uploads count as events for the rate
   *  limit. */
  maxUploadBytes: number
  maxUploadFiles: number
}>

const DEFAULT_LIMITS: Limits = {
  maxBodyBytes: 16 * 1024,
  eventsPerSecond: 20,
  eventBurst: 40,
  sessionsPerVisitor: 16,
  maxSessions: 20_000,
  unconnectedTimeout: '30 seconds',
  maxPendingInputs: 32,
  pagesPerSecond: 5,
  pageBurst: 50,
  maxUploadBytes: 10 * 1024 * 1024,
  maxUploadFiles: 10,
}

const DEFAULT_DATASTAR_URL =
  'https://cdn.jsdelivr.net/gh/starfederation/datastar@1.0.4/bundles/datastar.js'
const DEFAULT_DATASTAR_INTEGRITY =
  'sha384-twbOvafhSBQ0rJDNPzJdUw6DRvthVgAVfSIG1BQVmCiNO7Qh2zeVn7T5qstgjJ9q'

const CONTROL_ID = 'hyper-control'
/** Signal carrying browser effects of forwarded Commands. */
const ACTIONS_SIGNAL = '_hc'
const RUN_ACTIONS = 'hyperRunActions'
/** Signal carrying the intake position of each render (local effects). */
const APPLIED_SIGNAL = '_ha'
const APPLIED = 'hyperApplied'
const NAVIGATE_PATH = '/nav'
const NAVIGATE = 'hyperNavigate'
const VISITOR_COOKIE = 'hyper-visitor'
const VISITOR_MAX_AGE = 60 * 60 * 24 * 365
/** Beyond this many tracked client addresses the page buckets start over. */
const MAX_TRACKED_CLIENTS = 100_000

/** Session ids are random UUIDs; anything else is rejected before it can
 *  reach a lookup or the snapshot store. */
const SESSION_ID =
  /^(?:[a-z0-9]{1,16}\.)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const NODE = /^[a-z0-9]{1,16}$/

/** The node that holds the session a request is for, from its path: the
 *  prefix of the session id (`/_hyper/<program>/s/<node>.<uuid>…`). For a
 *  router in front of several processes; undefined for page requests and
 *  sessions without a node. */
export const nodeOfPath = (path: string): string | undefined =>
  path.match(/^\/_hyper\/[^/]+\/s\/([a-z0-9]{1,16})\.[0-9a-f-]{36}(?:[/?]|$)/)?.[1]

/* Page script.
   - Records values typed into client-owned inputs until their debounced post
     goes out; every event post takes them along (see `binding.post`). A
     value that arrives with a change event alone becomes an input event.
   - Marks elements whose event request is in flight with `aria-busy` and the
     document with `data-hyper-pending`, from Datastar's fetch lifecycle
     events. The session stream (the control element) does not count. */
const CLIENT_SCRIPT = `(() => {
  const unsent = new Set()
  const flushed = new WeakMap()
  const announced = new WeakMap()
  document.addEventListener('input', event => {
    if (!event.target?.hasAttribute?.('${INPUT_HANDLER_ATTRIBUTE}')) return
    unsent.add(event.target)
    announced.set(event.target, event.target.value)
  }, true)
  // Some fills (password managers, older autofill) set the value and fire
  // only change: announce it as the input it is.
  document.addEventListener('change', event => {
    const el = event.target
    if (el?.hasAttribute?.('${INPUT_HANDLER_ATTRIBUTE}') && announced.get(el) !== el.value) {
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }, true)
  window.${PENDING_INPUTS} = () => {
    const values = {}
    for (const el of unsent) {
      values[el.getAttribute('${INPUT_HANDLER_ATTRIBUTE}')] = el.value
      flushed.set(el, { value: el.value, at: Date.now() })
    }
    unsent.clear()
    return values
  }
  window.${FRESH_VALUE} = el => {
    unsent.delete(el)
    const last = flushed.get(el)
    return !(last && last.value === el.value && Date.now() - last.at < 1000)
  }
  const literals = new Map()
  const literal = encoded => {
    if (!literals.has(encoded)) {
      const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
      literals.set(encoded, JSON.parse(new TextDecoder().decode(bytes)))
    }
    return literals.get(encoded)
  }
  const focusSoon = (selector, tries = 10) => {
    const target = document.querySelector(selector)
    if (target) target.focus()
    else if (tries > 0) requestAnimationFrame(() => focusSoon(selector, tries - 1))
  }
  window.${FOCUS} = encoded => requestAnimationFrame(() => focusSoon(literal(encoded)))
  window.${FOCUS_KEY} = (evt, encoded) => {
    const selector = literal(encoded)[evt.key]
    if (selector === undefined) return false
    evt.preventDefault()
    requestAnimationFrame(() => focusSoon(selector))
    return true
  }
  window.${COPY_TEXT} = (evt, encoded) => {
    evt.clipboardData?.setData('text/plain', literal(encoded))
    evt.preventDefault()
  }
  // A forwarded focus arrives a round trip after the user acted. It moves
  // focus unless the user has moved it since: focus is still where it was
  // when they acted (the clicked button, the input they typed in), or
  // nowhere, or already inside the target's widget.
  const WIDGET = '[role="tablist"],[role="group"],[role="menu"],[role="menubar"],[role="listbox"],[role="grid"],[role="radiogroup"],[role="toolbar"],[role="tree"]'
  let focusAtAction = null
  const focusIfStillThere = (selector, tries = 10) => {
    const target = document.querySelector(selector)
    if (!target) {
      if (tries > 0) requestAnimationFrame(() => focusIfStillThere(selector, tries - 1))
      return
    }
    const active = document.activeElement
    const widget = target.closest(WIDGET) ?? target.parentElement
    const moved = active && active !== document.body && active !== focusAtAction && !widget?.contains(active)
    if (!moved) target.focus()
  }
  // Dialogs, as Foldkit UI's Dom.showDialog: the rest of the page is inert
  // and scroll is locked while one is open, Escape on the topmost becomes a
  // cancelable cancel event, Tab stays inside, and focus returns on close.
  // Morphs remove the inert marks (the server's markup has none), so they
  // are put back after every patch.
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]'
  const focusables = root => [...root.querySelectorAll(FOCUSABLE)].filter(el => el.getClientRects().length > 0)
  const dialogs = new Map()
  let dialogStack = []
  const topDialog = () => dialogStack[dialogStack.length - 1]
  const isolate = () => {
    for (const el of document.querySelectorAll('[data-hyper-inert]')) { el.inert = false; el.removeAttribute('data-hyper-inert') }
    dialogStack = dialogStack.filter(id => document.getElementById(id))
    const top = dialogStack.length === 0 ? null : document.getElementById(topDialog())
    document.documentElement.style.overflow = top ? 'hidden' : ''
    for (let node = top; node && node !== document.body && node.parentElement; node = node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling !== node && !sibling.inert && !/^(SCRIPT|STYLE|LINK)$/.test(sibling.tagName)) {
          sibling.inert = true
          sibling.setAttribute('data-hyper-inert', '')
        }
      }
    }
  }
  const showDialog = (el, focusSelector) => {
    if (!(el instanceof HTMLDialogElement) || !el.id) return false
    el.style.position = 'fixed'
    el.style.inset = '0'
    if (!el.open) el.show()
    if (dialogs.has(el.id)) { isolate(); return true }
    const active = document.activeElement
    const onKey = evt => {
      const current = document.getElementById(el.id)
      if (!current?.open || topDialog() !== el.id) return
      if (evt.key === 'Escape') {
        if (evt.defaultPrevented) return
        evt.preventDefault()
        current.dispatchEvent(new CustomEvent('cancel', { cancelable: true }))
      } else if (evt.key === 'Tab') {
        const inside = focusables(current)
        if (inside.length === 0) { evt.preventDefault(); current.focus(); return }
        if (evt.shiftKey && document.activeElement === inside[0]) { evt.preventDefault(); inside[inside.length - 1].focus() }
        else if (!evt.shiftKey && document.activeElement === inside[inside.length - 1]) { evt.preventDefault(); inside[0].focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    dialogs.set(el.id, { onKey, returnFocus: active instanceof HTMLElement && active !== document.body ? active : null })
    dialogStack = [...dialogStack.filter(id => id !== el.id), el.id]
    isolate()
    const requested = focusSelector ? el.querySelector(focusSelector) : null
    ;(requested ?? focusables(el)[0] ?? el).focus()
    return true
  }
  const releaseDialog = id => {
    const held = dialogs.get(id)
    if (!held) return false
    document.removeEventListener('keydown', held.onKey)
    dialogs.delete(id)
    dialogStack = dialogStack.filter(other => other !== id)
    isolate()
    if (held.returnFocus?.isConnected) held.returnFocus.focus()
    return true
  }
  const closeDialog = el => {
    if (!(el instanceof HTMLDialogElement)) return false
    if (el.open) el.close()
    releaseDialog(el.id)
    return true
  }
  // Local effects (local.ts): applied at once, then re-applied after every
  // morph until the server's intake position passes the event's sequence
  // number, so a render made before the event cannot undo them.
  const pendingLocal = []
  const setVisible = (target, isOpen) => {
    target.hidden = !isOpen
    target.setAttribute('data-state', isOpen ? 'open' : 'closed')
    if (target.id) {
      for (const trigger of document.querySelectorAll('[aria-controls="' + CSS.escape(target.id) + '"]')) {
        trigger.setAttribute('aria-expanded', String(isOpen))
      }
    }
  }
  const applyLocal = op => {
    const target = (op.id && document.getElementById(op.id)) || op.target
    if (op.kind === 'visible' && target) setVisible(target, op.isOpen)
    else if (op.kind === 'dialog' && target) op.isOpen ? showDialog(target, op.focus) : closeDialog(target)
    else if (op.kind === 'select') {
      const within = document.querySelector(op.within)
      if (within) for (const item of within.querySelectorAll(op.items)) item.setAttribute(op.attribute, String(item.id === op.selected))
    }
  }
  const elementOf = (selector, el) => selector === ':scope' ? el : document.querySelector(selector)
  const runLocal = (effects, el, sequence) => {
    const ops = []
    let selectedId = ''
    for (const effect of effects) {
      const shown = effect.show ?? effect.hide ?? effect.toggle
      if (shown !== undefined) {
        const target = elementOf(shown, el)
        if (target) ops.push({ kind: 'visible', target, id: target.id, isOpen: effect.show !== undefined || (effect.toggle !== undefined && target.hidden) })
      } else if (effect.showDialog !== undefined || effect.closeDialog !== undefined) {
        const target = elementOf(effect.showDialog ?? effect.closeDialog, el)
        if (target) ops.push({ kind: 'dialog', target, id: target.id, isOpen: effect.showDialog !== undefined, focus: effect.focus })
      } else if (effect.focus !== undefined) {
        const target = elementOf(effect.focus, el)
        requestAnimationFrame(() => target?.focus())
      } else if (effect.select !== undefined) {
        const { within, by, scroll } = effect.select
        const attribute = effect.select.attribute ?? 'data-selected'
        const items = effect.select.items ?? '[' + attribute + ']'
        const list = [...(document.querySelector(within)?.querySelectorAll(items) ?? [])]
        if (list.length === 0) continue
        const index = list.findIndex(item => item.getAttribute(attribute) === 'true')
        const next = list[index === -1 ? (by > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, index + by))]
        selectedId = next.id
        ops.push({ kind: 'select', within, items, attribute, selected: next.id })
        if (scroll !== false) next.scrollIntoView({ block: 'nearest' })
      }
    }
    for (const op of ops) applyLocal(op)
    if (ops.length > 0) pendingLocal.push({ sequence, ops })
    return selectedId
  }
  window.${LOCAL} = (el, evt, sequence) => {
    let effects
    try { effects = JSON.parse(el.getAttribute('${LOCAL_ATTRIBUTE}') ?? '{}')[evt.type] } catch { return }
    if (Array.isArray(effects)) runLocal(effects, el, sequence)
  }
  window.${APPLIED} = json => {
    if (!json) return
    const { p } = JSON.parse(json)
    if (typeof p === 'number') {
      for (let index = pendingLocal.length - 1; index >= 0; index -= 1) {
        if (pendingLocal[index].sequence < p) pendingLocal.splice(index, 1)
      }
    }
    for (const entry of pendingLocal) for (const op of entry.ops) applyLocal(op)
    isolate()
  }
  // Escape or a click outside a shown panel with dismiss effects dispatches
  // the dismiss event on it; its binding hides it locally and tells the server.
  const dismiss = outside => {
    for (const panel of document.querySelectorAll('[${LOCAL_ATTRIBUTE}*="${DISMISS_EVENT}"]')) {
      if (panel.hidden || panel.closest('[hidden]')) continue
      if (outside && (panel.contains(outside) || (panel.id && outside.closest?.('[aria-controls="' + CSS.escape(panel.id) + '"]')))) continue
      panel.dispatchEvent(new CustomEvent('${DISMISS_EVENT}'))
    }
  }
  document.addEventListener('pointerdown', evt => dismiss(evt.target), true)
  document.addEventListener('keydown', evt => { if (evt.key === 'Escape' && !evt.defaultPrevented) dismiss(null) })
  // A forwarded Command with replies posts its outcome, unnumbered.
  const reply = (endpoint, id, outcome) => {
    if (!id || !endpoint) return
    fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'Datastar-Request': 'true', 'Content-Type': 'application/json' }, body: JSON.stringify({ r: id, o: outcome }) })
      .catch(() => console.warn('hyper-effect: reply failed'))
  }
  // Navigation within the session (onUrlChange): links to URLs the program
  // serves are taken on mousedown (the server starts before the click ends),
  // the address bar follows on click, and back/forward post the URL again.
  // Modified clicks, other targets and downloads stay with the browser.
  const control = () => document.getElementById('${CONTROL_ID}')
  const inSession = url => {
    const paths = control()?.getAttribute('data-hyper-paths')
    if (!paths || url.origin !== location.origin) return false
    const parts = url.pathname.split('/').filter(part => part !== '')
    return JSON.parse(paths).some(pattern => {
      const patternParts = pattern.split('/').filter(part => part !== '')
      return patternParts.length === parts.length && patternParts.every((part, index) => part.startsWith(':') || part === parts[index])
    })
  }
  const navigateInSession = url => {
    const endpoint = control()?.getAttribute('data-hyper-endpoint')
    if (!endpoint) { location.assign(url.href); return }
    fetch(endpoint + '${NAVIGATE_PATH}', { method: 'POST', credentials: 'same-origin', headers: { 'Datastar-Request': 'true', 'Content-Type': 'application/json' }, body: JSON.stringify({ u: url.pathname + url.search }) })
      .then(async response => {
        if (response.status === 204) return
        const answer = response.status === 200 ? await response.json() : {}
        location.assign(typeof answer.load === 'string' ? answer.load : url.href)
      })
      .catch(() => location.assign(url.href))
  }
  const linkOf = evt => {
    if (evt.button !== 0 || evt.metaKey || evt.ctrlKey || evt.shiftKey || evt.altKey || evt.defaultPrevented) return null
    const anchor = evt.target instanceof Element ? evt.target.closest('a[href]') : null
    if (!anchor || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download') || anchor.hasAttribute('data-hyper-reload')) return null
    const url = new URL(anchor.href, location.href)
    return inSession(url) ? url : null
  }
  let pressedLink = null
  document.addEventListener('mousedown', evt => {
    const url = linkOf(evt)
    pressedLink = url && url.href !== location.href ? url : null
    if (pressedLink) navigateInSession(pressedLink)
  })
  document.addEventListener('click', evt => {
    const url = linkOf(evt)
    if (!url) return
    evt.preventDefault()
    if (url.href !== location.href) {
      history.pushState(null, '', url.href)
      if (pressedLink?.href !== url.href) navigateInSession(url)
    }
    pressedLink = null
  })
  // Pressed but dragged away: the page stays where the address bar is.
  document.addEventListener('dragstart', () => {
    if (pressedLink) { pressedLink = null; navigateInSession(new URL(location.href)) }
  })
  window.addEventListener('popstate', () => { if (inSession(new URL(location.href))) navigateInSession(new URL(location.href)); else location.reload() })
  const sameOrigin = url => { try { return new URL(url, location.href).origin === location.origin } catch { return false } }
  let lastActions = ''
  window.${RUN_ACTIONS} = (json, endpoint) => {
    if (!json || json === lastActions) return
    lastActions = json
    for (const action of JSON.parse(json).actions) {
      if (action.focus) focusIfStillThere(action.focus)
      if (action.scrollIntoView) document.querySelector(action.scrollIntoView)?.scrollIntoView({ block: 'nearest' })
      if (action.replaceUrl && sameOrigin(action.replaceUrl)) history.replaceState(history.state, '', action.replaceUrl)
      if (action.pushUrl && sameOrigin(action.pushUrl)) history.pushState(null, '', action.pushUrl)
      if (action.load && sameOrigin(action.load)) {
        const url = new URL(action.load, location.href)
        if (inSession(url)) { history.pushState(null, '', url.href); navigateInSession(url) } else location.assign(url.href)
      }
      if (action.click) document.querySelector(action.click)?.click()
      if (action.showDialog) reply(endpoint, action.reply, showDialog(document.querySelector(action.showDialog), action.focus) ? 'ok' : 'failed')
      if (action.closeDialog) { closeDialog(document.querySelector(action.closeDialog)); reply(endpoint, action.reply, 'ok') }
      if (action.releaseDialog) { releaseDialog(action.releaseDialog); reply(endpoint, action.reply, 'ok') }
    }
  }
  // Key bindings (keys.ts): the host element carries the table; matching
  // follows Foldkit's Subscription.keyBindings, so the page posts only the
  // Message of a binding that matched.
  const APPLE = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
  const MODIFIER_KEYS = ['alt', 'altgraph', 'capslock', 'control', 'fn', 'fnlock', 'hyper', 'meta', 'numlock', 'os', 'scrolllock', 'shift', 'super', 'symbol', 'symbollock']
  const sequences = new WeakMap()
  const normalizeKey = key => key === ' ' ? ' ' : String(key).trim().toLowerCase()
  const isEditable = evt => evt.composedPath().some(target =>
    target instanceof HTMLElement && (/^(input|textarea|select)$/i.test(target.tagName) || target.isContentEditable))
  const pressMatches = (press, evt) => {
    const [key, control, meta, alt, shift, mod] = press
    return key === normalizeKey(evt.key) && alt === evt.altKey && shift === evt.shiftKey &&
      (control || (mod && !APPLE)) === evt.ctrlKey && (meta || (mod && APPLE)) === evt.metaKey
  }
  const keyTables = new Map()
  const keyTable = encoded => {
    if (!keyTables.has(encoded)) {
      const table = JSON.parse(encoded)
      for (const binding of table.b) {
        const [, field, value] = /^([mh]): '([^']*)'$/.exec(binding.x) ?? []
        binding.x = field === undefined ? {} : { [field]: value }
      }
      keyTables.clear()
      keyTables.set(encoded, table)
    }
    return keyTables.get(encoded)
  }
  window.${KEYS} = (evt, el, sequence) => {
    const table = keyTable(el.getAttribute('data-hyper-keys') ?? '{"t":1000,"b":[]}')
    const state = sequences.get(el)
    const clear = () => { if (state) clearTimeout(state.timer); sequences.delete(el) }
    const remember = (bindings, count) => {
      clear()
      sequences.set(el, { bindings, count, timer: setTimeout(() => sequences.delete(el), table.t) })
    }
    if (evt.defaultPrevented || evt.isComposing) { clear(); return undefined }
    if (MODIFIER_KEYS.includes(normalizeKey(evt.key))) return undefined
    if (evt.repeat && state) return undefined
    const typing = isEditable(evt)
    const allowed = binding => !typing || binding.w
    const emit = binding => {
      clear()
      if (binding.d) evt.preventDefault()
      const targetId = document.activeElement?.id ?? ''
      const selectedId = binding.l ? runLocal(binding.l, el, sequence) : ''
      return binding.v ? { ...binding.x, x: [targetId, selectedId] } : binding.x
    }
    const fresh = () => {
      const single = table.b.find(binding => binding.p.length === 1 && allowed(binding) &&
        (!evt.repeat || binding.r) && pressMatches(binding.p[0], evt))
      if (single) return emit(single)
      if (evt.repeat) return undefined
      const begun = table.b.filter(binding => binding.p.length > 1 && allowed(binding) && pressMatches(binding.p[0], evt))
      if (begun.length > 0) {
        remember(begun, 1)
        if (begun[0].d) evt.preventDefault()
      }
      return undefined
    }
    if (!state) return fresh()
    const next = state.bindings.filter(binding => allowed(binding) &&
      binding.p[state.count] !== undefined && pressMatches(binding.p[state.count], evt))
    if (next.length === 0) { clear(); return fresh() }
    const done = next.find(binding => binding.p.length === state.count + 1)
    if (done) return emit(done)
    remember(next, state.count + 1)
    if (next[0].d) evt.preventDefault()
    return undefined
  }
  window.${NAVIGATE} = encoded => encoded ? location.assign(literal(encoded)) : location.reload()
  const busy = new Map()
  let pending = 0
  const started = el => {
    focusAtAction = document.activeElement
    pending += 1
    busy.set(el, (busy.get(el) ?? 0) + 1)
    el.setAttribute('aria-busy', 'true')
    document.documentElement.toggleAttribute('data-hyper-pending', true)
  }
  const finished = el => {
    pending = Math.max(0, pending - 1)
    const count = (busy.get(el) ?? 1) - 1
    if (count > 0) busy.set(el, count)
    else { busy.delete(el); el.removeAttribute('aria-busy') }
    document.documentElement.toggleAttribute('data-hyper-pending', pending > 0)
  }
  document.addEventListener('datastar-fetch', event => {
    const { type, el } = event.detail
    if (!(el instanceof Element) || el.id === '${CONTROL_ID}') return
    if (type === 'started') started(el)
    else if (type === 'finished') finished(el)
  })
  // Files go up as multipart, with the event's sequence number and the
  // unsent input values, like every other event. A 200 answer is a
  // navigation (the session ended): reload, as Datastar would.
  window.${UPLOAD} = (el, files, handler, sequence, endpoint) => {
    const body = new FormData()
    body.set('h', handler.h)
    body.set('q', String(sequence))
    body.set('p', JSON.stringify(window.${PENDING_INPUTS}?.() ?? {}))
    for (const file of files ?? []) body.append('f', file, file.name)
    if (el instanceof HTMLInputElement) el.value = ''
    started(el)
    fetch(endpoint + '${UPLOAD_PATH}', { method: 'POST', body, headers: { 'Datastar-Request': 'true' }, credentials: 'same-origin' })
      .then(response => {
        if (response.status === 200) location.reload()
        else if (!response.ok) console.warn('hyper-effect: upload refused (' + response.status + ')')
      })
      .catch(() => console.warn('hyper-effect: upload failed'))
      .finally(() => finished(el))
  }
})()`

/* A thin progress bar while any event is in flight; it only appears when the
   server is slower than 150 ms, so fast interactions do not flicker. */
const CLIENT_STYLE = `
html[data-hyper-pending] body::before {
  content: ''; position: fixed; inset: 0 0 auto 0; height: 2px; z-index: 9999;
  background: var(--color-primary, currentColor); transform-origin: left;
  animation: hyper-pending 900ms ease-out 150ms infinite both;
}
@keyframes hyper-pending { from { transform: scaleX(0); opacity: 1 } to { transform: scaleX(1); opacity: 0.2 } }
[aria-busy='true'] { cursor: progress }
`

const escapeText = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const escapeAttribute = (value: string): string =>
  escapeText(value).replace(/"/g, '&quot;')

const titleTag = (title: string): string =>
  `<title id="${Session.TITLE_ID}">${escapeText(title)}</title>`

type Entry<Model, Message> = {
  readonly session: Session.Session<Model, Message>
  snapshots: Fiber.Fiber<void> | undefined
  /** The browser the session belongs to. */
  readonly visitorId: string
  /** Who the session acts for (`Options.principal`). */
  readonly principal: string | undefined
  readonly createdAt: number
  connections: number
  everConnected: boolean
  lastSeen: number
  /** When the session's snapshot was last written. */
  snapshotAt: number
  /** Snapshot writes, one at a time: requested, and covered by a finished
   *  write. A request is covered by the first write that starts after it. */
  readonly saving: Semaphore.Semaphore
  saveRequests: number
  savedRequests: number
  closed: boolean
  /** Token bucket for the event rate limit. */
  readonly events: Security.Bucket
}

/** How a request for a session this node does not hold turns out. */
type Restored<Model, Message> =
  | Readonly<{ _tag: 'Restored'; entry: Entry<Model, Message> }>
  | Readonly<{ _tag: 'Refused' }>
  /** Held here, but for another browser. */
  | Readonly<{ _tag: 'Forbidden' }>
  /** The browser should go elsewhere; `location` undefined reloads the page. */
  | Readonly<{ _tag: 'Navigate'; location: string | undefined }>

const refused = { _tag: 'Refused' } as const

const decodePayload = Schema.decodeUnknownEffect(Session.EventPayload)
const decodeNavigation = Schema.decodeUnknownEffect(Schema.Struct({ u: Schema.String }))
const decodePendingInputs = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
)

const notFound = HttpServerResponse.text(
  '<!doctype html><title>Not found</title><h1>Not found</h1>',
  { status: 404, contentType: 'text/html' },
)

const refuse = (status: number) => HttpServerResponse.empty({ status })

/** Headers of every event stream. Reverse proxies buffer responses by
 *  default (nginx does), which holds patches back until a buffer fills;
 *  `X-Accel-Buffering: no` turns that off for this response alone. */
const STREAM_HEADERS = { 'cache-control': 'no-cache', 'x-accel-buffering': 'no' }

/** Answers a stream or event request with a navigation instead: the page
 *  goes to `location`, or reloads without one. The location travels as a
 *  base64url literal, never inside the expression itself. */
const navigation = (location: string | undefined) =>
  HttpServerResponse.text(
    runOnce(
      `window.${NAVIGATE}('${
        location === undefined ? '' : Buffer.from(JSON.stringify(location)).toString('base64url')
      }')`,
    ),
    { contentType: 'text/event-stream', headers: STREAM_HEADERS },
  )

const secretList = (
  secret: Security.Secret | ReadonlyArray<Security.Secret>,
): ReadonlyArray<Security.Secret> =>
  typeof secret === 'string' || Redacted.isRedacted(secret) ? [secret] : secret

/** Serves a program: the page itself (plain SSR, works without JavaScript),
 *  the session's SSE stream that Datastar opens on load, and the event
 *  endpoint the page's `data-on:*` bindings post to.
 *
 *  Sessions are snapshotted to the `KeyValueStore` (Schema-encoded Model), so
 *  after a restart, or on another node with a shared store, the next request
 *  for a session restores it instead of starting over. Without a snapshot the
 *  page's Flags are recomputed from its URL. */
export const layer = <Model, Message, ClientMessage extends Message, Flags, R>(
  program: Program<Model, Message, ClientMessage, Flags, R>,
  options: Options<R> = {},
) => {
  if (options.node !== undefined && !NODE.test(options.node)) {
    throw new Error(`hyper-effect: node "${options.node}" must be 1–16 lowercase letters or digits.`)
  }
  return HttpRouter.use(router =>
    Effect.gen(function* () {
      const services = yield* Effect.context<R>()
      const store = KeyValueStore.prefix(
        yield* KeyValueStore.KeyValueStore,
        `hyper/${program.name}/`,
      )
      // A snapshot records whose session it is, so a restore stays bound to
      // the same browser and principal, and when it was written.
      const snapshotJson = Schema.fromJsonString(
        Schema.Struct({
          visitorId: Schema.String,
          principal: Schema.NullOr(Schema.String),
          savedAt: Schema.Number,
          /** The next sequence number the session expected: a restored
           *  session continues from it, so retried events are not applied
           *  twice. */
          position: Schema.optional(Schema.NullOr(Schema.Number)),
          /** Skipped sequence numbers: a late event among them is applied
           *  after a restore, not dropped as a repeat. */
          skipped: Schema.optional(Schema.Array(Schema.Number)),
          model: Schema.toCodecJson(program.Model),
        }),
      )
      type Snapshot = typeof snapshotJson.Type
      const encodeSnapshot = Schema.encodeEffect(snapshotJson)
      const decodeSnapshot = Schema.decodeUnknownEffect(snapshotJson)
      const sealer =
        options.snapshotSecret === undefined
          ? undefined
          : Security.makeSealer(secretList(options.snapshotSecret), `snapshot:${program.name}`)
      const snapshotTtl = Duration.toMillis(
        Duration.fromInputUnsafe(options.snapshotTtl ?? '1 day'),
      )
      const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits }
      const unconnectedTimeout = Duration.toMillis(
        Duration.fromInputUnsafe(limits.unconnectedTimeout),
      )
      const allowedOrigins = options.allowedOrigins ?? []
      const newSessionId = () =>
        options.node === undefined ? crypto.randomUUID() : `${options.node}.${crypto.randomUUID()}`
      const trustProxy = options.trustProxy ?? 0
      const csp = options.contentSecurityPolicy ?? {}

      const sessions = new Map<string, Entry<Model, Message>>()
      /** Page buckets per client address. */
      const clients = new Map<string, Security.Bucket>()
      Metrics.registerProgram(program.name, () => {
        let connections = 0
        let handlerTables = 0
        let regions = 0
        for (const entry of sessions.values()) {
          connections += entry.connections
          const retained = entry.session.retained()
          handlerTables += retained.handlerTables
          regions += retained.regions
        }
        return { sessions: sessions.size, connections, handlerTables, regions }
      })
      const patterns = [options.path ?? '/', ...(options.paths ?? [])]
      const idleTimeout = Duration.toMillis(
        Duration.fromInputUnsafe(options.idleTimeout ?? '2 minutes'),
      )
      const datastarUrl = options.datastarUrl ?? DEFAULT_DATASTAR_URL
      const datastarIntegrity =
        options.datastarIntegrity ??
        (datastarUrl === DEFAULT_DATASTAR_URL ? DEFAULT_DATASTAR_INTEGRITY : undefined)
      const endpoint = (id: string) => Session.endpointFor(program.name, id)

      const pageRequest = (
        url: URL,
        visitorId: string,
        request: HttpServerRequest.HttpServerRequest,
      ): Option.Option<PageRequest> =>
        Option.fromNullishOr(
          patterns.map(pattern => matchPath(pattern, url.pathname)).find(params => params !== undefined),
        ).pipe(
          Option.map(params => ({
            url,
            params,
            visitorId,
            cookies: request.cookies,
            headers: request.headers,
          })),
        )

      const principalOf = (request: HttpServerRequest.HttpServerRequest, visitorId: string) =>
        options.principal === undefined
          ? Effect.succeed(undefined)
          : options
              .principal({ cookies: request.cookies, headers: request.headers, visitorId })
              .pipe(Effect.provideContext(services))

      /** Takes one page token for the request's client address. */
      const allowPage = (request: HttpServerRequest.HttpServerRequest): boolean => {
        const address = Security.clientAddress(request, trustProxy)
        const now = Date.now()
        let bucket = clients.get(address)
        if (bucket === undefined) {
          if (clients.size >= MAX_TRACKED_CLIENTS) clients.clear()
          bucket = Security.fullBucket(limits.pageBurst, now)
          clients.set(address, bucket)
        }
        return Security.take(bucket, limits.pagesPerSecond, limits.pageBurst, now)
      }

      const writeSnapshot = (id: string, snapshot: Snapshot) =>
        encodeSnapshot(snapshot).pipe(
          Effect.map(json => (sealer === undefined ? json : sealer.seal(json, id))),
          Effect.flatMap(value => store.set(id, value)),
        )

      /** The session's snapshot, unless it is missing, unreadable (another
       *  secret, tampered, plain while a secret is set) or expired. */
      const readSnapshot = (id: string) =>
        store.get(id).pipe(
          Effect.flatMap(value => {
            const json =
              value === undefined
                ? Option.none<string>()
                : sealer === undefined
                  ? Option.some(value)
                  : sealer.open(value, id)
            return Option.isNone(json)
              ? Effect.succeed(Option.none<Snapshot>())
              : decodeSnapshot(json.value).pipe(Effect.map(Option.some))
          }),
          Effect.map(Option.filter(snapshot => Date.now() - snapshot.savedAt <= snapshotTtl)),
          Effect.orElseSucceed(() => Option.none<Snapshot>()),
        )

      const durableEvents = options.durableEvents ?? true

      /** Writes the session's snapshot as it is now: every event applied so
       *  far is in it. Writes queue up behind each other; requests made
       *  while one runs share the next. */
      const saveSnapshot = (entry: Entry<Model, Message>) =>
        Effect.suspend(() => {
          const request = (entry.saveRequests += 1)
          return entry.saving.withPermits(1)(
            Effect.suspend(() => {
              if (entry.closed || entry.savedRequests >= request) return Effect.void
              const covered = entry.saveRequests
              const savedAt = Date.now()
              const { model, position, skipped } = entry.session.applied()
              return writeSnapshot(entry.session.id, {
                visitorId: entry.visitorId,
                principal: entry.principal ?? null,
                savedAt,
                position: position ?? null,
                ...(skipped.length === 0 ? {} : { skipped }),
                model,
              }).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    entry.snapshotAt = savedAt
                    entry.savedRequests = covered
                  }),
                ),
                Effect.catchCause(cause => Effect.logWarning('Snapshot failed', cause)),
              )
            }),
          )
        })

      const close = (id: string, entry: Entry<Model, Message>) =>
        Effect.gen(function* () {
          sessions.delete(id)
          entry.closed = true
          if (entry.snapshots !== undefined) yield* Fiber.interrupt(entry.snapshots)
          yield* entry.session.close
          // After any write in progress, so none lands after the removal.
          yield* entry.saving.withPermits(1)(store.remove(id).pipe(Effect.ignore))
        })

      /** Keeps one visitor within `sessionsPerVisitor` by closing their
       *  oldest session (a forgotten tab) before a new one opens. */
      const makeRoomFor = (visitorId: string) =>
        Effect.gen(function* () {
          const own = [...sessions].filter(([, entry]) => entry.visitorId === visitorId)
          if (own.length < limits.sessionsPerVisitor) return
          const [oldestId, oldest] = own.reduce((a, b) => (a[1].createdAt <= b[1].createdAt ? a : b))
          yield* close(oldestId, oldest)
        })

      const register = (
        session: Session.Session<Model, Message>,
        visitorId: string,
        principal: string | undefined,
      ) =>
        Effect.gen(function* () {
          const now = Date.now()
          const entry: Entry<Model, Message> = {
            session,
            snapshots: undefined,
            visitorId,
            principal,
            createdAt: now,
            connections: 0,
            everConnected: false,
            lastSeen: now,
            snapshotAt: now,
            saving: Semaphore.makeUnsafe(1),
            saveRequests: 0,
            savedRequests: 0,
            closed: false,
            events: Security.fullBucket(limits.eventBurst, now),
          }
          // Snapshot after changes of the session's own state, when the
          // program says what that is (else after every change). The intake
          // position counts as its own: events the page sent must not be
          // expected again after a restore. Checked right after each update,
          // so other changes cost no wake-up at all.
          const snapshotDeps = program.snapshotDeps
          const due = yield* Queue.sliding<void>(1)
          let own: ReadonlyArray<unknown> | undefined
          session.onUpdate(model => {
            if (snapshotDeps !== undefined) {
              const next = [...snapshotDeps(model), session.applied().position]
              if (own !== undefined && sameDeps(own, next)) return
              own = next
            }
            Queue.offerUnsafe(due, undefined)
          })
          Queue.offerUnsafe(due, undefined)
          entry.snapshots = yield* Stream.fromQueue(due).pipe(
            // A quiet second, not every change: snapshots trade a little UI state
            // on a crash for far fewer store writes under load.
            Stream.debounce('1 second'),
            Stream.runForEach(() => saveSnapshot(entry)),
            Effect.forkDetach,
          )
          sessions.set(session.id, entry)
          return entry
        })

      const start = (id: string, request: PageRequest, principal: string | undefined) =>
        program.flags(request).pipe(
          Effect.tap(() => makeRoomFor(request.visitorId)),
          Effect.flatMap(flags => {
            const initial = program.init(flags)
            return Session.make(program, id, {
              model: initial.model,
              ...(initial.commands === undefined ? {} : { commands: initial.commands }),
              firstSequence: 1,
            })
          }),
          Effect.flatMap(session => register(session, request.visitorId, principal)),
          Effect.provideContext(services),
        )

      /** A prefetch: the page as `start` would render it, without
       *  registering a session or running init's Commands. */
      const preview = (id: string, request: PageRequest) =>
        program.flags(request).pipe(
          Effect.flatMap(flags =>
            Session.make(program, id, { model: program.init(flags).model, firstSequence: 1 }),
          ),
          Effect.flatMap(session => session.render.pipe(Effect.orDie, Effect.ensuring(session.close))),
          Effect.provideContext(services),
        )

      const notifyConnection = (entry: Entry<Model, Message>, isConnected: boolean) =>
        program.onConnectionChange === undefined
          ? Effect.void
          : entry.session.dispatch(program.onConnectionChange(isConnected))

      /** A session this node does not hold: restore its snapshot, or start
       *  over from the page URL when there is none. A snapshot of another
       *  visitor's session is never restored for this one. Both run against
       *  the same limits as opening a page. */
      const restore = (
        id: string,
        request: HttpServerRequest.HttpServerRequest,
        pageUrl: Option.Option<URL>,
        visitorId: string,
        principal: string | undefined,
      ) =>
        Effect.gen(function* () {
          if (sessions.size >= limits.maxSessions || !allowPage(request)) return refused
          const snapshot = yield* readSnapshot(id)
          if (Option.isSome(snapshot)) {
            if (snapshot.value.visitorId !== visitorId) return refused
            yield* makeRoomFor(visitorId)
            const position = snapshot.value.position
            const entry = yield* Session.make(program, id, {
              model: snapshot.value.model,
              ...(position === undefined || position === null ? {} : { firstSequence: position }),
              ...(snapshot.value.skipped === undefined ? {} : { skipped: snapshot.value.skipped }),
            }).pipe(
              Effect.flatMap(session =>
                register(session, visitorId, snapshot.value.principal ?? undefined),
              ),
              Effect.provideContext(services),
            )
            // The snapshot may say "connected"; nobody is until a stream opens.
            yield* notifyConnection(entry, false)
            return { _tag: 'Restored', entry } as const
          }
          const page = Option.flatMap(pageUrl, url => pageRequest(url, visitorId, request))
          if (Option.isNone(page)) return refused
          return yield* start(id, page.value, principal).pipe(
            Effect.map(entry => ({ _tag: 'Restored', entry }) as const),
            Effect.catchTag('PageRedirect', ({ location }) =>
              Effect.succeed({ _tag: 'Navigate', location } as const),
            ),
            // A reload shows the page's 404.
            Effect.catchTag('PageNotFound', () =>
              Effect.succeed({ _tag: 'Navigate', location: undefined } as const),
            ),
            Effect.orElseSucceed(() => refused),
          )
        })

      /** The session for a stream or event request: held here, or restored. */
      const find = (
        id: string,
        request: HttpServerRequest.HttpServerRequest,
        pageUrl: Option.Option<URL>,
        visitorId: string,
        principal: string | undefined,
      ): Effect.Effect<Restored<Model, Message>> => {
        const known = sessions.get(id)
        if (known === undefined) return restore(id, request, pageUrl, visitorId, principal)
        return Effect.succeed(
          known.visitorId === visitorId
            ? { _tag: 'Restored', entry: known }
            : { _tag: 'Forbidden' },
        )
      }

      const securityHeaders = (nonce: string): Record<string, string> => ({
        'x-content-type-options': 'nosniff',
        ...(csp === false
          ? {}
          : {
              [csp.reportOnly === true
                ? 'content-security-policy-report-only'
                : 'content-security-policy']: Security.contentSecurityPolicy(
                nonce,
                csp.directives,
              ),
            }),
      })

      const page = (rendered: Session.Rendered, id: string, url: URL, nonce: string): string => {
        const pageUrl = encodeURIComponent(url.pathname + url.search)
        const integrity =
          datastarIntegrity === undefined
            ? ''
            : ` integrity="${escapeAttribute(datastarIntegrity)}" crossorigin="anonymous"`
        return [
          '<!doctype html>',
          '<html lang="en">',
          '<head>',
          '<meta charset="utf-8">',
          '<meta name="viewport" content="width=device-width, initial-scale=1">',
          titleTag(rendered.title),
          ...(options.stylesheets ?? []).map(
            href => `<link rel="stylesheet" href="${escapeAttribute(href)}">`,
          ),
          `<style nonce="${nonce}">${CLIENT_STYLE}</style>`,
          `<script nonce="${nonce}">${CLIENT_SCRIPT}</script>`,
          `<script type="module" nonce="${nonce}" src="${escapeAttribute(datastarUrl)}"${integrity}></script>`,
          ...(options.prefetch === undefined || options.prefetch.length === 0
            ? []
            : [
                `<script type="speculationrules" nonce="${nonce}">${JSON.stringify({
                  prefetch: [{ where: { href_matches: options.prefetch }, eagerness: 'moderate' }],
                }).replace(/</g, '\\u003c')}</script>`,
              ]),
          ...(options.scripts ?? []).map(
            src => `<script type="module" nonce="${nonce}" src="${escapeAttribute(src)}"></script>`,
          ),
          '</head>',
          '<body>',
          `<div hidden id="${CONTROL_ID}" data-signals:${SEQUENCE_SIGNAL}="0" data-signals:${ENDPOINT_SIGNAL}="'${endpoint(id)}'" data-signals:${ACTIONS_SIGNAL}="''" data-signals:${APPLIED_SIGNAL}="''" data-effect="window.${APPLIED}?.($${APPLIED_SIGNAL}); window.${RUN_ACTIONS}?.($${ACTIONS_SIGNAL}, $${ENDPOINT_SIGNAL})" data-init="@get('${endpoint(id)}/stream?u=${pageUrl}')" data-hyper-endpoint="${endpoint(id)}"${
            program.onUrlChange === undefined ? '' : ` data-hyper-paths="${escapeAttribute(JSON.stringify(patterns))}"`
          }></div>`,
          rendered.html,
          '</body>',
          '</html>',
        ].join('\n')
      }

      for (const pattern of patterns) {
      yield* router.add(
        'GET',
        /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
        pattern as HttpRouter.PathInput,
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const url = new URL(request.url, 'http://localhost')
          const knownVisitor = request.cookies[VISITOR_COOKIE]
          const visitorId = knownVisitor ?? crypto.randomUUID()
          const secure = request.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
          const withVisitor = (response: HttpServerResponse.HttpServerResponse) =>
            knownVisitor === undefined
              ? HttpServerResponse.setHeader(
                  response,
                  'set-cookie',
                  `${VISITOR_COOKIE}=${visitorId}; Path=/; Max-Age=${VISITOR_MAX_AGE}; SameSite=Lax; HttpOnly${secure}`,
                )
              : response
          const matched = pageRequest(url, visitorId, request)
          if (Option.isNone(matched)) {
            return notFound
          }
          if (!allowPage(request)) {
            return HttpServerResponse.text('Too many requests, slow down.', {
              status: 429,
              headers: { 'retry-after': '1' },
            })
          }
          if (sessions.size >= limits.maxSessions) {
            return HttpServerResponse.text('Too many open pages, try again shortly.', {
              status: 503,
              headers: { 'retry-after': '10' },
            })
          }
          const purpose = request.headers['sec-purpose'] ?? request.headers['purpose'] ?? ''
          if (/prefetch/i.test(purpose)) {
            const id = newSessionId()
            const previewed = yield* preview(id, matched.value).pipe(
              Effect.map(rendered => ({ _tag: 'Rendered', rendered }) as const),
              Effect.catchTag('PageNotFound', () => Effect.succeed({ _tag: 'NotFound' } as const)),
              Effect.catchTag('PageRedirect', ({ location, status }) =>
                Effect.succeed({ _tag: 'Redirect', location, status } as const),
              ),
            )
            if (previewed._tag === 'NotFound') return notFound
            if (previewed._tag === 'Redirect') {
              return withVisitor(
                HttpServerResponse.redirect(previewed.location, { status: previewed.status ?? 303 }),
              )
            }
            const nonce = Security.makeNonce()
            return withVisitor(
              HttpServerResponse.html(page(previewed.rendered, id, url, nonce)).pipe(
                HttpServerResponse.setHeaders(securityHeaders(nonce)),
              ),
            )
          }
          const principal = yield* principalOf(request, visitorId)
          const started = yield* start(newSessionId(), matched.value, principal).pipe(
            Effect.map(entry => ({ _tag: 'Started', entry }) as const),
            Effect.catchTag('PageNotFound', () => Effect.succeed({ _tag: 'NotFound' } as const)),
            Effect.catchTag('PageRedirect', ({ location, status }) =>
              Effect.succeed({ _tag: 'Redirect', location, status } as const),
            ),
          )
          if (started._tag === 'NotFound') {
            return notFound
          }
          if (started._tag === 'Redirect') {
            return withVisitor(
              HttpServerResponse.redirect(started.location, { status: started.status ?? 303 }),
            )
          }
          const entry = started.entry
          const rendered = yield* entry.session.render
          const nonce = Security.makeNonce()
          return withVisitor(
            HttpServerResponse.html(page(rendered, entry.session.id, url, nonce)).pipe(
              HttpServerResponse.setHeaders(securityHeaders(nonce)),
            ),
          )
        }).pipe(
          Effect.catchCause(cause =>
            Effect.logError('Page render failed', cause).pipe(
              Effect.as(HttpServerResponse.text('Render failed', { status: 500 })),
            ),
          ),
        ),
      )
      }

      yield* router.add(
        'GET',
        `/_hyper/${program.name}/s/:id/stream`,
        Effect.gen(function* () {
          const { id = '' } = yield* HttpRouter.params
          const request = yield* HttpServerRequest.HttpServerRequest
          const visitorId = request.cookies[VISITOR_COOKIE]
          if (!SESSION_ID.test(id)) return refuse(400)
          if (
            request.headers['datastar-request'] !== 'true' ||
            visitorId === undefined ||
            !Security.isSameSite(request, allowedOrigins, trustProxy)
          ) {
            return refuse(403)
          }
          const search = new URL(request.url, 'http://localhost').searchParams
          const pageUrl = Option.fromNullishOr(search.get('u')).pipe(
            Option.filter(value => value.startsWith('/') && !value.startsWith('//')),
            Option.map(value => new URL(value, 'http://localhost')),
          )
          const principal = yield* principalOf(request, visitorId)
          const found = yield* find(id, request, pageUrl, visitorId, principal)
          if (found._tag === 'Refused' || found._tag === 'Forbidden') return refuse(403)
          if (found._tag === 'Navigate') return navigation(found.location)
          const entry = found.entry
          if (entry.principal !== principal) {
            yield* close(id, entry)
            return navigation(undefined)
          }
          entry.connections += 1
          entry.everConnected = true
          let actionBatches = 0
          let renders = 0
          if (entry.connections === 1) {
            yield* notifyConnection(entry, true)
          }

          // What this connection's page shows: the frame, title and region
          // versions it was sent last. The first patch sends the whole page;
          // after that, while the frame is unchanged, only changed regions.
          let shownFrame: string | undefined
          let shownTitle: string | undefined
          const shownRegions = new Map<string, number>()

          const patches = SubscriptionRef.changes(entry.session.model).pipe(
            // Conflate: while a render is running, keep only the newest change.
            // A burst of changes costs one render, never a backlog.
            Stream.buffer({ capacity: 1, strategy: 'sliding' }),
            Stream.mapEffect(() => entry.session.render),
            Stream.map(({ html, frame, regions, title, signals, actions, position }) => {
              // After this morph the page re-applies local effects the
              // render does not reflect yet, then runs forwarded Commands.
              const withApplied = {
                ...signals,
                [APPLIED_SIGNAL]: JSON.stringify({ n: (renders += 1), p: position ?? null }),
              }
              const withActions =
                actions.length === 0
                  ? withApplied
                  : {
                      ...withApplied,
                      [ACTIONS_SIGNAL]: JSON.stringify({ n: (actionBatches += 1), actions }),
                    }
              const elements: Array<string> = []
              if (title !== shownTitle) elements.push(titleTag(title))
              const regionsOnly = frame === shownFrame
              const isChanged = (regionId: string | undefined) =>
                regionId !== undefined &&
                shownRegions.get(regionId) !== regions.get(regionId)?.version
              if (regionsOnly) {
                for (const [regionId, region] of regions) {
                  if (!isChanged(regionId)) continue
                  // A changed region an ancestor of it carries already.
                  let ancestor = region.parent
                  while (ancestor !== undefined && !isChanged(ancestor)) {
                    ancestor = regions.get(ancestor)?.parent
                  }
                  if (ancestor === undefined) elements.push(region.html)
                }
              } else {
                elements.push(html)
              }
              // After this patch the page shows exactly these regions.
              shownRegions.clear()
              for (const [regionId, region] of regions) shownRegions.set(regionId, region.version)
              shownFrame = frame
              shownTitle = title
              const patch =
                (elements.length > 0 ? patchElements(elements.join('\n')) : '') +
                (Object.keys(withActions).length > 0 ? patchSignals(withActions) : '')
              if (patch !== '') Metrics.recordPatch(patch.length, regionsOnly)
              return patch
            }),
            Stream.filter(patch => patch !== ''),
          )
          const heartbeats = Stream.tick('15 seconds').pipe(
            Stream.drop(1),
            Stream.map(() => heartbeat),
          )
          const encoding =
            options.compression === true ? Compression.negotiate(request.headers['accept-encoding']) : undefined
          const body = Stream.merge(patches, heartbeats).pipe(
            Stream.encodeText,
            stream => (encoding === undefined ? stream : stream.pipe(Compression.compress(Metrics.recordWire))),
            Stream.ensuring(
              Effect.suspend(() => {
                entry.connections -= 1
                entry.lastSeen = Date.now()
                return entry.connections === 0
                  ? notifyConnection(entry, false)
                  : Effect.void
              }),
            ),
          )

          return HttpServerResponse.stream(body, {
            contentType: 'text/event-stream',
            headers:
              encoding === undefined
                ? STREAM_HEADERS
                : { ...STREAM_HEADERS, 'content-encoding': encoding, vary: 'accept-encoding' },
          })
        }),
      )

      yield* router.add(
        'POST',
        `/_hyper/${program.name}/s/:id`,
        Effect.gen(function* () {
          const { id = '' } = yield* HttpRouter.params
          const request = yield* HttpServerRequest.HttpServerRequest
          const visitorId = request.cookies[VISITOR_COOKIE]
          if (!SESSION_ID.test(id)) return refuse(400)
          if (
            request.headers['datastar-request'] !== 'true' ||
            visitorId === undefined ||
            !Security.isSameSite(request, allowedOrigins, trustProxy)
          ) {
            return refuse(403)
          }
          const length = Number(request.headers['content-length'] ?? 0)
          if (length > limits.maxBodyBytes) return refuse(413)

          const principal = yield* principalOf(request, visitorId)
          const found = yield* find(id, request, Option.none(), visitorId, principal)
          if (found._tag === 'Forbidden') return refuse(403)
          if (found._tag !== 'Restored') return refuse(410)
          const entry = found.entry
          if (entry.principal !== principal) {
            yield* close(id, entry)
            return navigation(undefined)
          }
          if (!Security.take(entry.events, limits.eventsPerSecond, limits.eventBurst, Date.now())) {
            return refuse(429)
          }

          const payload = yield* request.json.pipe(
            Effect.provideService(
              HttpIncomingMessage.MaxBodySize,
              ByteSize.bytes(limits.maxBodyBytes),
            ),
            Effect.flatMap(decodePayload),
          )
          if (Object.keys(payload.p ?? {}).length > limits.maxPendingInputs) return refuse(400)
          yield* entry.session.receive(payload)
          if (durableEvents) yield* saveSnapshot(entry)
          entry.lastSeen = Date.now()
          return refuse(204)
        }).pipe(Effect.catch(() => Effect.succeed(refuse(400)))),
      )

      // Navigation within the session (`onUrlChange`): the page posts the
      // URL it went to. 204: the session took it; `{ load }`: load a page.
      yield* router.add(
        'POST',
        `/_hyper/${program.name}/s/:id${NAVIGATE_PATH}`,
        Effect.gen(function* () {
          const { id = '' } = yield* HttpRouter.params
          const request = yield* HttpServerRequest.HttpServerRequest
          const visitorId = request.cookies[VISITOR_COOKIE]
          if (!SESSION_ID.test(id)) return refuse(400)
          if (
            request.headers['datastar-request'] !== 'true' ||
            visitorId === undefined ||
            !Security.isSameSite(request, allowedOrigins, trustProxy)
          ) {
            return refuse(403)
          }
          const principal = yield* principalOf(request, visitorId)
          const found = yield* find(id, request, Option.none(), visitorId, principal)
          if (found._tag === 'Forbidden') return refuse(403)
          if (found._tag !== 'Restored') return refuse(410)
          const entry = found.entry
          if (entry.principal !== principal) {
            yield* close(id, entry)
            return refuse(410)
          }
          if (!Security.take(entry.events, limits.eventsPerSecond, limits.eventBurst, Date.now())) {
            return refuse(429)
          }
          const { u } = yield* request.json.pipe(
            Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(limits.maxBodyBytes)),
            Effect.flatMap(decodeNavigation),
          )
          // A path of this origin only; anything else is not a navigation.
          if (!u.startsWith('/') || u.startsWith('//')) return refuse(400)
          const load = (location: string) => HttpServerResponse.jsonUnsafe({ load: location })
          const onUrlChange = program.onUrlChange
          const page = pageRequest(new URL(u, 'http://localhost'), visitorId, request)
          if (onUrlChange === undefined || Option.isNone(page)) return load(u)
          const changed = yield* onUrlChange(page.value).pipe(
            Effect.provideContext(services),
            Effect.map(message => ({ _tag: 'Message' as const, message })),
            Effect.catchTags({
              PageNotFound: () => Effect.succeed({ _tag: 'Load' as const, location: u }),
              PageRedirect: ({ location }) => Effect.succeed({ _tag: 'Load' as const, location }),
            }),
          )
          if (changed._tag === 'Load') return load(changed.location)
          yield* entry.session.dispatch(changed.message)
          entry.lastSeen = Date.now()
          return refuse(204)
        }).pipe(Effect.catch(() => Effect.succeed(refuse(400)))),
      )

      // Uploads: files for an `OnFileChange`/`OnDropFiles` handler, as
      // multipart. The same checks as events, then limits on bytes and files.
      // Files are read into memory (the byte limit bounds them) and reach
      // `update` as web `File`s, exactly as in the browser.
      yield* router.add(
        'POST',
        `/_hyper/${program.name}/s/:id${UPLOAD_PATH}`,
        Effect.gen(function* () {
          const { id = '' } = yield* HttpRouter.params
          const request = yield* HttpServerRequest.HttpServerRequest
          const visitorId = request.cookies[VISITOR_COOKIE]
          if (!SESSION_ID.test(id)) return refuse(400)
          if (
            request.headers['datastar-request'] !== 'true' ||
            visitorId === undefined ||
            !Security.isSameSite(request, allowedOrigins, trustProxy)
          ) {
            return refuse(403)
          }
          const length = Number(request.headers['content-length'] ?? 0)
          if (length > limits.maxUploadBytes) return refuse(413)

          const principal = yield* principalOf(request, visitorId)
          const found = yield* find(id, request, Option.none(), visitorId, principal)
          if (found._tag === 'Forbidden') return refuse(403)
          if (found._tag !== 'Restored') return refuse(410)
          const entry = found.entry
          if (entry.principal !== principal) {
            yield* close(id, entry)
            return navigation(undefined)
          }
          if (!Security.take(entry.events, limits.eventsPerSecond, limits.eventBurst, Date.now())) {
            return refuse(429)
          }

          const fields = new Map<string, string>()
          const files: Array<File> = []
          let tooMany = false
          yield* request.multipartStream.pipe(
            Stream.runForEach(part =>
              Multipart.isField(part)
                ? Effect.sync(() => {
                    fields.set(part.key, part.value)
                  })
                : Multipart.isFile(part) && part.key === 'f'
                  ? files.length >= limits.maxUploadFiles
                    ? Effect.sync(() => {
                        tooMany = true
                      })
                    : part.contentEffect.pipe(
                        Effect.map(bytes => {
                          files.push(new File([new Uint8Array(bytes)], part.name, { type: part.contentType }))
                        }),
                      )
                  : Effect.void,
            ),
            Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(limits.maxUploadBytes)),
            // Room for the three fields and one file too many, which the count
            // above answers with 413.
            Effect.provideService(Multipart.MaxParts, limits.maxUploadFiles + 4),
            Effect.provideService(Multipart.MaxFileSize, ByteSize.bytes(limits.maxUploadBytes)),
          )
          if (tooMany) return refuse(413)
          const handlerId = fields.get('h')
          const sequence = Number(fields.get('q'))
          if (handlerId === undefined || !Number.isInteger(sequence)) return refuse(400)
          const pendingInputs = yield* decodePendingInputs(fields.get('p') ?? '{}')
          if (Object.keys(pendingInputs).length > limits.maxPendingInputs) return refuse(400)
          yield* entry.session.receive({ h: handlerId, files, q: sequence, p: pendingInputs })
          if (durableEvents) yield* saveSnapshot(entry)
          entry.lastSeen = Date.now()
          return refuse(204)
        }).pipe(Effect.catch(() => Effect.succeed(refuse(400)))),
      )

      // Close sessions nobody is connected to, and forget their snapshots.
      // Pages whose stream never connected go sooner. Live sessions keep
      // their snapshot younger than its TTL, and full page buckets go.
      yield* Effect.gen(function* () {
        const now = Date.now()
        for (const [id, entry] of sessions) {
          const timeout = entry.everConnected ? idleTimeout : unconnectedTimeout
          if (entry.connections === 0 && now - entry.lastSeen > timeout) {
            yield* close(id, entry)
          } else if (entry.connections > 0 && now - entry.snapshotAt > snapshotTtl / 2) {
            yield* saveSnapshot(entry)
          }
        }
        for (const [address, bucket] of clients) {
          if (Security.isRefilled(bucket, limits.pagesPerSecond, limits.pageBurst, now)) {
            clients.delete(address)
          }
        }
      }).pipe(
        Effect.delay('10 seconds'),
        Effect.forever,
        Effect.forkScoped,
      )
    }),
  )
}

/** `GET /_hyper/metrics` (JSON) and `POST /_hyper/metrics/reset`. Opt-in: it
 *  exposes load and memory figures, so mount it only where that is fine. */
export const metricsRoutes = Layer.mergeAll(
  HttpRouter.add(
    'GET',
    '/_hyper/metrics',
    Effect.sync(() =>
      HttpServerResponse.text(JSON.stringify(Metrics.snapshot()), {
        contentType: 'application/json',
      }),
    ),
  ),
  HttpRouter.add(
    'POST',
    '/_hyper/metrics/reset',
    Effect.sync(() => {
      Metrics.reset()
      return HttpServerResponse.empty({ status: 204 })
    }),
  ),
  // A CPU profile of the running server (`.cpuprofile` JSON), for load tests.
  HttpRouter.add(
    'POST',
    '/_hyper/metrics/profile',
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const seconds = Number(new URL(request.url, 'http://localhost').searchParams.get('seconds') ?? 5)
      const profile = yield* Effect.promise(() => Metrics.captureProfile(seconds * 1000))
      return HttpServerResponse.text(profile, { contentType: 'application/json' })
    }),
  ),
)
