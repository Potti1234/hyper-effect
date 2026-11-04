/* Client command forwarding (experiment 3 spike).

   Some Commands only make sense in a browser: moving focus, scrolling an
   element into view. Run on the server they fail, which breaks keyboard
   navigation in server-side Submodels. A forwarded Command is not run;
   instead its browser effect is sent to the page with the next morph, and the
   page script performs it after the morph is applied.

   Forwarding needs a table from Command name and args to the browser effect,
   because Foldkit's `Dom` helpers touch `document` directly and cannot be
   intercepted. The table below mirrors Foldkit UI's id conventions, which
   are internal; the real fix is upstream (Dom operations as an Effect
   service a server runtime can implement).

   A forwarded Command's result Message is dropped. That is only correct for
   acknowledgements (`CompletedFocusTab`); Commands whose result drives
   further updates must not be forwarded. */

export type ClientAction =
  | Readonly<{ focus: string }>
  | Readonly<{ scrollIntoView: string }>
  /** `history.replaceState` to a URL of the same origin: in-page state
   *  (a page number, a filter) reflected in the address bar. */
  | Readonly<{ replaceUrl: string }>
  /** Navigates to a URL of the same origin, as Foldkit's `Navigation.load`. */
  | Readonly<{ load: string }>
  /** Clicks an element, as Foldkit's `Dom.clickElement`: Foldkit UI commits a
   *  keyboard-chosen item (Enter in a combobox, listbox or menu) by clicking
   *  it, so the item's own click binding posts the selection. */
  | Readonly<{ click: string }>

export type ClientCommands = Readonly<
  Record<string, (args: Readonly<Record<string, unknown>>) => ClientAction | undefined>
>

const cssEscape = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, char => `\\${char}`)

const idSelector = (id: string): string => `#${cssEscape(id)}`

const part = (suffix: string) => (args: Readonly<Record<string, unknown>>) =>
  typeof args['id'] === 'string' ? idSelector(`${args['id']}-${suffix}`) : undefined

const item = (args: Readonly<Record<string, unknown>>) =>
  typeof args['id'] === 'string' && typeof args['index'] === 'number'
    ? idSelector(`${args['id']}-item-${args['index']}`)
    : undefined

const focusOn = (selector: string | undefined): ClientAction | undefined =>
  selector === undefined ? undefined : { focus: selector }

/** DOM Commands of Foldkit UI primitives used by crease/ui (tabs, combobox,
 *  listbox, menu), by their element id conventions. A Command of another
 *  name, or with other arguments, runs as usual. */
export const foldkitUiCommands: ClientCommands = {
  FocusTab: ({ id, index }) =>
    typeof id === 'string' && typeof index === 'number'
      ? { focus: idSelector(`${id}-tab-${index}`) }
      : undefined,
  FocusInput: args => focusOn(part('input')(args)),
  FocusButton: args => focusOn(part('button')(args)),
  FocusItems: args => focusOn(part('items')(args)),
  ScrollIntoView: args => {
    const selector = item(args)
    return selector === undefined ? undefined : { scrollIntoView: selector }
  },
  ClickItem: args => {
    const selector = item(args)
    return selector === undefined ? undefined : { click: selector }
  },
}
