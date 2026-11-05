# Working on Starter

This is a hyper-effect app. Before changing it, load the `hyper-effect` skill (and the `foldkit` skill for Foldkit itself); they explain the architecture, the rules and where to find working references.

- Pages are Foldkit programs whose update loop runs on the server. Keep update and view pure; side effects are Commands.
- Only Messages listed in a page's `ClientMessage` may be bound in its view; typed text goes through `onInput`/`onChange` handlers. Re-check permissions in update.
- Wrap independently changing parts of a page in `region(h, { id, deps, render })` and list every Model field the region reads in `deps`.
- Commands run on the server: no `window`, `document` or `localStorage`.
- Keyboard shortcuts, focus, drag and drop, menus and dialogs: read the skill's `references/browser.md` before building them (shortcuts are `keyBindings(h, [...])`; focus is a forwarded Command).
- Done means: `npm run typecheck`, `npm test` and `npm run check` (against `npm start`) pass.
