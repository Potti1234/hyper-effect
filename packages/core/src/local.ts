import type { Attribute, HtmlBuilder } from 'foldkit/html'

/* Local effects: screen-only changes the browser makes at once, before the
   server has seen the event.

   Every interaction of a hyper-effect page is a round trip: event, update on
   the server, morph. For changes to data that is right. For changes to the
   screen alone (a panel opens, the selection moves, a dialog shows) it is a
   visible lag. A local effect does that change in the page script right away
   and posts the event as usual; the server applies the Message, renders what
   the browser already shows, and the morph changes nothing visible.

   The set of effects is fixed and small. There is no client code and no
   expression language: each effect is a few tested lines of the page script,
   and the view stays the one description of the page. The Model stays the
   source of truth, including for the screen state: an effect only shows
   early what the Model is about to say.

   Reconciliation: until the server has applied the event (its intake
   position passes the event's sequence number), the page re-applies the
   effect after every morph, so a render made before the event cannot undo
   it. After that the server's markup is authoritative again.

   An effect needs a bound event on the same element (`h.OnClick(Message.X())`
   and `local(h, { click: [...] })`): a Model that never hears about the change
   would render it away. Panels shown with `show` or `toggle` can be closed by
   the page on Escape or a click outside: give the panel `dismiss` effects and
   an `h.OnCustomEvent({ name: DISMISS_EVENT, ... })` binding. */

/** Selectors are document selectors; `':scope'` is the element itself. */
export type LocalEffect =
  /** Shows an element: removes `hidden`, sets `data-state="open"` and
   *  `aria-expanded="true"` on elements whose `aria-controls` names it. */
  | Readonly<{ show: string }>
  | Readonly<{ hide: string }>
  /** `show` when hidden, `hide` otherwise, decided when the event happens. */
  | Readonly<{ toggle: string }>
  | Readonly<{ focus: string }>
  /** Opens a `<dialog>` as Foldkit UI's `Dom.showDialog` does (modal
   *  isolation, focus trap, Escape as `cancel`, scroll lock, return focus). */
  | Readonly<{ showDialog: string; focus?: string }>
  | Readonly<{ closeDialog: string }>
  /** Roving selection: moves `attribute` (default `data-selected`, set to
   *  `"true"`/`"false"`) among the `items` of `within` by `by` steps. The
   *  new item's id reaches a key binding's Message as `selectedId`. */
  | Readonly<{
      select: Readonly<{
        within: string
        by: number
        items?: string
        attribute?: string
        /** Scrolls the new item into view. Default true. */
        scroll?: boolean
      }>
    }>

/** Effects per DOM event name (`click`, `pointerdown`, `hyperdismiss`). */
export type LocalEffects = Readonly<Record<string, ReadonlyArray<LocalEffect>>>

export const LOCAL_ATTRIBUTE = 'data-hyper-local'
/** Page script function running an element's local effects. */
export const LOCAL = 'hyperLocal'
/** Dispatched on a shown panel that has effects for it when the user presses
 *  Escape or clicks outside it (and outside its `aria-controls` trigger). */
export const DISMISS_EVENT = 'hyperdismiss'

/** Declares the local effects of an element's bound events.
 *
 *  ```ts
 *  h.button(
 *    [
 *      h.AriaControls('filters'),
 *      h.OnClick(Message.ToggledFilters()),
 *      local(h, { click: [{ toggle: '#filters' }] }),
 *    ],
 *    ['Filters'],
 *  )
 *  ```
 */
export const local = <Message>(h: HtmlBuilder<Message>, effects: LocalEffects): Attribute<Message> =>
  h.Attribute(LOCAL_ATTRIBUTE, JSON.stringify(effects))

/** The page's DOM event name of a `data-on:` attribute key. */
export const eventOfBinding = (key: string): string | undefined => {
  const match = /^data-on:([a-z-]+)/.exec(key)
  return match?.[1]
}
