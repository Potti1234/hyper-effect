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
export const shortcutBindings = <Message>(
  hasOverlay: boolean,
  pressed: (shortcut: Shortcut, targetId: string) => Message,
): ReadonlyArray<KeyBinding<Message>> => {
  const press = (shortcut: Shortcut) => ({ targetId }: KeyContext) => pressed(shortcut, targetId)
  const listKey = (keys: string, shortcut: Shortcut): KeyBinding<Message> => ({
    keys,
    isEnabled: !hasOverlay,
    message: press(shortcut),
  })
  return [
    listKey('C', 'create'),
    listKey('J', 'down'),
    listKey('K', 'up'),
    listKey('ArrowDown', 'down'),
    listKey('ArrowUp', 'up'),
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
