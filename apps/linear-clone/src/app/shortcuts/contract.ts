import { Schema as S } from 'effect'

import type { KeyBinding, KeyContext } from '@hyper-effect/core'

/* The app's keyboard shortcuts, shared by the list and issue pages.

   Core's `keyBindings` renders them as one window-wide listener; the browser
   matches each key press (Foldkit's grammar and rules) and posts only a
   matching binding's Message. The pages decide what a shortcut means in
   update, from the Shortcut and where it was pressed (the focused element's
   id, which tells Mod+Enter which form to submit). */

export const Shortcut = S.Literals([
  'create',
  'down',
  'up',
  'open',
  'status',
  'priority',
  'assignee',
  'labels',
  'search',
  'palette',
  'escape',
  'submit',
  'goMyIssues',
  'goEngineering',
  'goDesign',
  'toggleLayout',
])
export type Shortcut = typeof Shortcut.Type

/** The binding table. List keys are off while an overlay (picker, dialog) is
 *  open; Escape, Mod+K and Mod+Enter also work while typing. */
/** Moving the selection in the browser: `J`/`K` and the arrows move
 *  `data-selected` among the items of `within` at once (a local effect) and
 *  report the item they moved to; the server only confirms. */
export type LocalSelection<Message> = Readonly<{
  within: string
  moved: (elementId: string) => Message
}>

export const shortcutBindings = <Message>(
  hasOverlay: boolean,
  pressed: (shortcut: Shortcut, targetId: string) => Message,
  selection?: LocalSelection<Message>,
): ReadonlyArray<KeyBinding<Message>> => {
  const press = (shortcut: Shortcut) => ({ targetId }: KeyContext) => pressed(shortcut, targetId)
  const listKey = (keys: string, shortcut: Shortcut): KeyBinding<Message> => ({
    keys,
    isEnabled: !hasOverlay,
    message: press(shortcut),
  })
  const moveKey = (keys: string, shortcut: 'down' | 'up'): KeyBinding<Message> =>
    selection === undefined
      ? listKey(keys, shortcut)
      : {
          keys,
          isEnabled: !hasOverlay,
          local: [{ select: { within: selection.within, by: shortcut === 'down' ? 1 : -1 } }],
          // No item to move to: the server decides, as without the effect.
          message: ({ targetId, selectedId }) =>
            selectedId === '' ? pressed(shortcut, targetId) : selection.moved(selectedId),
        }
  return [
    listKey('C', 'create'),
    moveKey('J', 'down'),
    moveKey('K', 'up'),
    moveKey('ArrowDown', 'down'),
    moveKey('ArrowUp', 'up'),
    listKey('Enter', 'open'),
    listKey('S', 'status'),
    listKey('P', 'priority'),
    listKey('A', 'assignee'),
    listKey('L', 'labels'),
    listKey('/', 'search'),
    { keys: ['G', 'M'], isEnabled: !hasOverlay, message: press('goMyIssues') },
    { keys: ['G', 'E'], isEnabled: !hasOverlay, message: press('goEngineering') },
    { keys: ['G', 'D'], isEnabled: !hasOverlay, message: press('goDesign') },
    { keys: 'Mod+B', message: press('toggleLayout') },
    { keys: 'Mod+K', whileTyping: 'Allow', message: press('palette') },
    { keys: 'Escape', whileTyping: 'Allow', message: press('escape') },
    { keys: 'Mod+Enter', whileTyping: 'Allow', message: press('submit') },
  ]
}
