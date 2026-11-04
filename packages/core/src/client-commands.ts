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

   A forwarded Command's result Message is dropped unless the entry names
   its replies (`{ action, replies }`): the Command's own result Messages for
   each outcome. The session lifts them through the Command's recorded
   Message mappers (`Command.mapMessage`), and the page posts which outcome
   happened, so a Submodel whose update depends on the result (Foldkit UI's
   dialog and its `SucceededShowDialog`) works on a server. The browser can
   only pick among the outcomes the server offered. */

export type ClientAction =
  | Readonly<{ focus: string }>
  | Readonly<{ scrollIntoView: string }>
  /** `history.replaceState` to a URL of the same origin: in-page state
   *  (a page number, a filter) reflected in the address bar. */
  | Readonly<{ replaceUrl: string }>
  /** Navigates to a URL of the same origin, as Foldkit's `Navigation.load`.
   *  A URL the program serves with `onUrlChange` stays in the session. */
  | Readonly<{ load: string }>
  /** `history.pushState` to a URL of the same origin, for a navigation the
   *  update has already made (the Model shows the new place). */
  | Readonly<{ pushUrl: string }>
  /** Clicks an element, as Foldkit's `Dom.clickElement`: Foldkit UI commits a
   *  keyboard-chosen item (Enter in a combobox, listbox or menu) by clicking
   *  it, so the item's own click binding posts the selection. */
  | Readonly<{ click: string }>
  /** Opens a `<dialog>` as Foldkit UI's `Dom.showDialog` does: modal
   *  isolation of the rest of the page, focus trap, Escape as a cancelable
   *  `cancel` CustomEvent, scroll lock, return focus on close. */
  | Readonly<{ showDialog: string; focus?: string; reply?: string }>
  | Readonly<{ closeDialog: string; reply?: string }>
  /** Releases what `showDialog` installed for the dialog of this id, which
   *  may have left the page. */
  | Readonly<{ releaseDialog: string; reply?: string }>

/** Outcomes of a forwarded Command, as its own (unlifted) result Messages. */
export type Replies = Readonly<{ ok: unknown; failed?: unknown }>

export type Forward = ClientAction | Readonly<{ action: ClientAction; replies: Replies }>

export const isWithReplies = (
  forward: Forward,
): forward is Readonly<{ action: ClientAction; replies: Replies }> => 'replies' in forward

export type ClientCommands = Readonly<
  Record<string, (args: Readonly<Record<string, unknown>>) => Forward | undefined>
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
  // Foldkit UI dialog (crease dialog, alert-dialog, sheet, drawer, command in
  // a dialog): the page performs Dom.showDialog / closeDialog and replies.
  ShowDialog: ({ id, focusSelector }) =>
    typeof id === 'string'
      ? {
          action: {
            showDialog: idSelector(id),
            ...(typeof focusSelector === 'string' ? { focus: focusSelector } : {}),
          },
          replies: { ok: { _tag: 'SucceededShowDialog' }, failed: { _tag: 'FailedShowDialog' } },
        }
      : undefined,
  CloseDialog: ({ id }) =>
    typeof id === 'string'
      ? { action: { closeDialog: idSelector(id) }, replies: { ok: { _tag: 'CompletedCloseDialog' } } }
      : undefined,
  ReleaseDialogResources: ({ id }) =>
    typeof id === 'string'
      ? {
          action: { releaseDialog: id },
          replies: { ok: { _tag: 'CompletedReleaseDialogResources' } },
        }
      : undefined,
}
