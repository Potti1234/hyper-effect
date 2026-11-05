# Experiment: a Linear clone on hyper-effect

Goal: build a production-quality clone of Linear's issue tracker with hyper-effect (Foldkit on the server, Effect 4, Datastar), using only the project skill, the app template and the repository as documentation, and record everything that made it hard.

**Status: done.** Tier 1 and Tier 2 complete, Tier 3 partly (drag and drop, dark mode). `npm run typecheck` and `npm test` (24 tests) pass; `scripts/check.mjs` (two people, 41 checks) passes in development and in production mode with no browser console errors and no server warnings or errors. About 5,100 lines (app, tests, scripts), built in roughly 3.5 hours of agent time.

How to run: see the end of this file.

## 1. Feature status

| Feature | Status | How |
|---|---|---|
| Sign-in, seeded workspace | done | The template's signed-cookie sign-in. A name matches a seeded member by first or full name ("Ada" → Ada Lovelace), otherwise joins the workspace. 6 members, 2 teams (ENG, DES), 7 labels, 40 issues (`ENG-1`…`ENG-26`, `DES-1`…`DES-14`), comments and activity (`src/app/seed.ts`). |
| App shell | done | Sidebar (workspace, My issues, All issues, teams with Issues/Board, three saved views, live counts, theme toggle, sign-out) and a top bar with the view's title, List/Board toggle, search and New issue (`src/app/view/shell.ts`). Pages are separate programs; navigating is a page load. |
| Issue list grouped by status | done | Groups in Linear's order (In Review, In Progress, Todo, Backlog, Done, Canceled) with sticky headers, counts, collapse and a "+" per group; dense 38 px rows with priority icon, identifier, status icon, title, label chips, date and assignee avatar. The status, priority and assignee icons on a row are buttons that open the picker. |
| Filters, search, My issues, in the URL | done | A Filter picker (status, priority, assignee, label; multi-select, typed filtering), filter chips with remove, Clear, search box; all mirrored into the address bar (`?status=todo,in_progress&label=bug&q=…&view=board`) and read back by Flags. My issues (`/my-issues`), All issues (`/issues`), team lists (`/team/ENG`). |
| Create issue | done | Linear-style modal: team, title, description, status, priority, assignee, labels (each through the picker), Schema validation with messages next to the field, Ctrl+Enter or the button, a toast with a link, the new issue selected. `c` anywhere (on the issue page it goes to `/team/X?new=1`). |
| Issue page `/issue/:identifier` | done | Inline-editable title (saved on Enter or leaving the field) and description (saved on blur), properties panel (status, priority, assignee, labels via the picker), team, created/updated, a timeline of activity entries (who changed what, from → to) and comments, comment box with validation and Ctrl+Enter, ⋯ menu (crease dropdown-menu: back, delete). Unknown identifier → 404; deleted while open → "was deleted". |
| Everything live + presence | done | One Subscription on the workspace's change feed per page: lists, boards, counts, the issue page, comments and activity update for everyone. The issue page shows who else is viewing it (scoped join while the page's connection is open). An edit by someone else replaces a field only when you are not editing it. |
| Board view | done | Columns by status, cards with identifier, status, title, priority, labels and assignee; moved with the status picker on a card, with `s`, or by drag and drop. |
| Keyboard | done | `c` new issue, `j`/`k` (and arrows) move the selection, `Enter` opens, `s`/`p`/`a`/`l` status/priority/assignee/labels of the selected issue, number keys inside status/priority pickers, `/` focuses search, Ctrl/Cmd+K command palette (actions, navigation, views, jump to any issue), Esc closes or goes back, Ctrl+Enter submits, `G` then `M`/`E`/`D` navigates, Ctrl+B toggles list/board. Through a small "keyboard island" (see F1). |
| Drag and drop on the board (Tier 3) | done | Native HTML5 drag events bound on the server (`OnDragStart`, `OnDragEnter`, `OnDrop`, `AllowDrop`): no island needed (see W1). The target column highlights while dragging. |
| Dark mode (Tier 3) | done | A per-person setting kept in the workspace store, so it follows the person to every open tab at once. Linear-like dark palette. |
| Projects, cycles, sub-issues (Tier 3) | not done | Time went into the record and verification instead. Nothing in the framework suggested they would be harder than labels. |

Screenshots: `screenshots/` (list, status picker, filter, filtered list, command palette, create issue, board, issue page with presence, labels picker, dark mode). Regenerate with `node scripts/screenshots.mjs` against a running server.

## 2. Friction log

Ordered roughly as found. Each entry: what happened, where, category, severity, time lost, workaround, proposed change. The most severe ones are F1, F5, F2, F14 and F11.

### F1. Global keyboard shortcuts have no server-side story
- **What happened:** Linear is keyboard-first (`c`, `j`/`k`, `s`, `/`, Ctrl+K anywhere on the page). In Foldkit the idiomatic tool is `Subscription.keyBindings` (found in `node_modules/foldkit/dist/subscription/keyBindings.d.ts`), which listens on `document`. On the server there is no `document`. Element handlers (`h.OnKeyDown`) are bound with `data-on:keydown` on the element itself; when nothing is focused the event target is `<body>`, which is outside the view's root element (the view renders *inside* `<body>`), so a handler on the root never sees the key. There is no `__window`/document binding (`packages/core/src/binding.ts`).
- **Where:** skill (`SKILL.md`, `references/gotchas.md` say nothing about global keys), `packages/core/src/binding.ts`.
- **Category:** skill gap + core API friction.
- **Severity:** costly.
- **Time:** ~30 min of reading `binding.ts`, `server.ts` and Foldkit's typings to understand why and what the options are.
- **Workaround:** a tiny "shortcuts" island: a Foldkit program in the browser whose only job is `Subscription.keyBindings`; it emits factual `Pressed { shortcut, targetId }` events, and the server page decides what they mean. This needs the whole island tool chain (Vite, `@hyper-effect/island`, a bundle, `scripts` option) for what is conceptually one attribute.
- **Proposed change:** (a) the skill should name global keyboard shortcuts explicitly and point at the island pattern; (b) better: core could support Foldkit's `Subscription.keyBindings` declaratively (the binding table is data: keys, `whileTyping`, `preventDefault`), rendering it as a `data-on:keydown__window` binding that posts the matching binding's Message token. That removes the need for an island for the most common browser-only behaviour of serious apps.

### F2. crease `command` (and probably every Combobox-based component): Enter does nothing on the server
- **What happened:** reading `crease/src/lib/command.ts`: Enter maps to `Combobox.Message.RequestedItemClick`, whose update in `@foldkit/ui/dist/combobox/shared.js` returns a `ClickItem` Command, a DOM click. On the server that Command needs a browser and is skipped, so Enter in the palette selects nothing. `docs/compatibility.md` lists Command as "Degraded … skips ShowDialog, WaitForPaint" with interaction "ok", because its smoke test only tries the first clickable Message.
- **Where:** `docs/compatibility.md`, `@foldkit/ui` combobox, crease `command.ts`.
- **Category:** crease component problem + compatibility doc misleading.
- **Severity:** costly (the command palette is a Tier 2 feature).
- **Time:** ~15 min reading.
- **Workaround:** my own palette/picker (crease command's classes and look, state in the page Model, keys bound with `OnKeyDownPreventDefault` on its input).
- **Proposed change:** forward `ClickItem` like `FocusTab` (a `{ click: selector }` client action), or have the combobox emit the selection Message directly when the item is known; make `check:compat` drive the keyboard path (Arrow + Enter), not only the first click.

### F3. The Foldkit skill points at a vendored `repos/foldkit` that does not exist
- **What happened:** the `foldkit` skill says the canonical references (examples, conventions, source) are in `repos/foldkit/`. This repo has no such directory; only the compiled `node_modules/foldkit/dist` (typings with doc comments, no examples).
- **Category:** skill gap (environment).
- **Severity:** minor (the `.d.ts` doc comments are good; `keyBindings.d.ts` was the best documentation I found).
- **Workaround:** read `.d.ts` files.
- **Proposed change:** the hyper-effect skill should say where Foldkit's API docs are in this repo (`node_modules/foldkit/dist/**/*.d.ts`) and list the Foldkit modules that do and do not work on the server (Subscription.keyBindings, fromEvent, animationFrame, Navigation, Dom).

### F4. Template `npm start` uses `tsx src/main.ts`
- **What happened:** on Windows a server started through `tsx` (or `npx tsx`) leaves a child process holding the port after the parent is stopped. The task brief warned about it.
- **Category:** template gap.
- **Severity:** minor.
- **Workaround:** start with `node --import tsx src/main.ts`.
- **Proposed change:** template `start` script: `npm run css && node --import tsx src/main.ts`.

### F5. A forwarded focus is refused after the user clicked something
- **What happened:** opening the picker from a button must focus its filter input. The documented way is a forwarded Command (`clientCommands` → `{ focus: selector }`). But the page script's `focusIfStillThere` (`packages/core/src/server.ts`) refuses to move focus when `document.activeElement` is not `<body>` and not inside the target's widget, and after a click the active element is the button that was clicked. So the documented mechanism silently does nothing in the most common case (click a trigger, a panel opens, focus its input). The same happens for Ctrl+K pressed while the search box has focus. Found by reading the page script before trying it.
- **Where:** `packages/core/src/server.ts` (`focusIfStillThere`, `WIDGET`), README ("A forwarded focus never pulls focus back from where the user has moved since"), skill `references/patterns.md`.
- **Category:** core API friction + skill gap.
- **Severity:** costly (no error; it just does not focus).
- **Time:** ~20 min.
- **Workaround:** the keyboard island also performs focus requests: the page puts `focus: { selector, seq }` in the Model, the island receives it as props and runs Foldkit's `Dom.focus` after the morph.
- **Proposed change:** distinguish "restore focus for a widget" (the current guarded behaviour, right for Foldkit UI's roving focus) from "focus this because the user just asked for it" (an explicit `{ focus: selector, force: true }` action, or treat focus requests caused by the event being answered as unguarded). Document it in the skill.

### F6. An island costs ~100 kB gzip even for a key listener
- **What happened:** the keyboard island (about 15 lines of logic) builds to `islands.js` 303 kB / 100 kB gzip: the Effect and Foldkit runtime. Every page loads it.
- **Category:** framework cost (island).
- **Severity:** minor for this app (cached once), real for a first load on mobile.
- **Proposed change:** see F1: built-in declarative key bindings and focus actions would make this island unnecessary.

### F7. Modifier-dependent keys cannot be bound on an element
- **What happened:** Ctrl/Cmd+Enter to submit the comment or the new-issue form is a Linear staple. `OnKeyDownPreventDefault` handlers are probed at render time with every key *without modifiers* (`binding.ts`, `NO_MODIFIERS`), so a handler returning Some only for Ctrl+Enter is never bound, and one returning Some for plain Enter would swallow newlines. Plain `OnKeyDown` posts every keystroke to the server.
- **Where:** `packages/core/src/binding.ts`; the README's "Known limits" mentions probing but not modifiers.
- **Category:** core API friction.
- **Severity:** minor (worked around).
- **Workaround:** the keyboard island binds `Mod+Enter` (with `whileTyping: 'Allow'`) and reports the focused element's id; the page decides which form to submit.
- **Proposed change:** probe each key with the modifier combinations too, or let the handler declare its keys.

### F8. crease `input` / `textarea` take no extra attributes
- **What happened:** inline editing (Linear's title and description) saves on blur. crease's `input` and `textarea` have no way to add an attribute such as `OnBlur` to the control.
- **Category:** crease component problem.
- **Severity:** minor.
- **Workaround:** the title sits in a `form` with `OnFocusLeave` (and `OnSubmit` for Enter); the description calls the lower-level `renderTextarea` from `src/lib/textarea.ts` with its own attribute list.
- **Proposed change:** an `attributes` prop on crease form controls.

### F9. Keyboard shortcuts are switched by server state, one round trip late
- **What happened:** the island turns list keys off while an overlay is open (`hasOverlay` prop). After Esc closes the palette, the island only learns it with the next morph, so `c` pressed within ~15 ms of Esc is ignored. The screenshot script hit it; a fast human can too.
- **Category:** framework design consequence (server-owned UI state, browser-owned key handling).
- **Severity:** minor.
- **Workaround:** none in the app (the scripts wait for the morph). One could send every key to the server and decide there, at the cost of a post per key.
- **Proposed change:** if core supports key bindings natively (F1), let a binding's `isEnabled` be evaluated in the browser from a signal the morph updates, and have the server ignore stale key events by sequence.

### F10. Test helper `serve()` mounts at `/` unless told otherwise
- **What happened:** my first HTTP tests answered 404 for `/team/ENG` because `serve(program)` mounts at the default path `/`; the template's test only uses `/`.
- **Where:** `@hyper-effect/core/testing` `serve`, template `test/tasks.test.ts`.
- **Category:** template gap.
- **Severity:** minor (~5 min).
- **Workaround:** `serve(program, { path: '/team/:team' }, …)`.
- **Proposed change:** a comment in the template test, or `serve` taking the same options object as `main.ts` (export the per-page options from one place).

### F11. The skill says drag and drop needs an island; it does not
- **What happened:** the skill (`SKILL.md` workflow step 4, `patterns.md`, README "three ways a component can live") lists drag and drop as browser-only, needing an island. In fact `binding.ts` binds `OnDragStart`, `OnDragEnter`, `OnDrop` and `AllowDrop` as plain Message events, and a board with native drag and drop works with three ClientMessages and no browser code. Found by reading `binding.ts` while planning the island.
- **Category:** skill wrong or misleading.
- **Severity:** costly if followed (an island would have meant re-implementing the board in the browser).
- **Time:** ~10 min to find, 15 min to build.
- **Proposed change:** in the skill, separate "drag and drop between server-rendered targets" (native events, works) from "drag with live preview, sorting animations, touch" (island).

### F12. HTTP tests: the first stream event is the whole page
- **What happened:** `readUntil(stream, 'data-status="done"')` returned at once because the stream starts by sending the full page, which already contains other done rows. The template's test waits for a text that only exists after the change, so it never shows this.
- **Category:** skill gap (testing).
- **Severity:** minor (~10 min).
- **Workaround:** wait for something new, or check the shared store's effect with a second `openPage`.
- **Proposed change:** note it in the skill's test section, or a `readPatchesAfter(stream, n)` helper.

### F13. The same program at several paths needs several names
- **What happened:** one list program serves `/team/:team`, `/my-issues` and `/issues`. Each `Hyper.layer` needs its own `program.name` (endpoints and snapshots), so the page exports `makeProgram(name, scope)` and `main.ts` mounts three. Documented in gotchas, so cheap; but it means three sets of endpoints and sessions for what is one page.
- **Category:** core API friction.
- **Severity:** minor.
- **Proposed change:** allow one program at several paths (the path is already in the session's URL).

### F14. No client-side navigation
- **What happened:** moving between the list, My issues and an issue is a full page load (132 kB HTML, 12 kB gzipped for a team list; 35 kB / 8 kB for an issue), a new session and a new stream. It is fast locally (~35 ms server time in development, a few ms in production), and the island bundle is cached, but Linear's instant view switches (sidebar → list with the scroll and selection kept) are not reachable. `clientCommands` offer `replaceUrl` and `load` but no `pushUrl`, so in-page view switches cannot create history entries either.
- **Category:** core API friction (architecture).
- **Severity:** costly for the "feels like Linear" goal, invisible for correctness.
- **Workaround:** filters, search and layout are in-page (`replaceUrl`); sidebar and issue links are page loads.
- **Proposed change:** a `pushUrl` client action plus a `popstate` → Message binding, so one program can own several URLs (with F13 this would let the list and its views be one session).

### F15. Environment notes (not the framework)
- `netstat` output is localized on this machine (German "ABHÖREN" instead of "LISTENING"), so my first restart script did not stop the old server and a new one died with `EADDRINUSE` while the old code kept answering; I stopped my server by `Get-NetTCPConnection -LocalPort 4100`. Worth a line in the template README for Windows.
- Escaping template literals through shell one-liners broke two of my own scripts; nothing to do with hyper-effect.

## 3. What worked well

- **W1. The architecture carried a big page without fighting.** The list page (list + board + filters + picker + create dialog + keyboard + drag and drop) is one Foldkit program of ~1,450 lines; it typechecked on the first full compile, and the first run of the two-person browser check passed 38 of 39 steps (the one failure was the check itself typing into a focused textarea).
- **W2. Live updates are free.** One Subscription on the store's change feed makes every list, board, count and issue page live. Nothing in the views knows whether a change came from this user or another one. Presence is ten lines (`onConnectionChange` + a scoped `join` in a Subscription that depends on `isConnected`), copied from the dispatch example.
- **W3. Regions with `shared: true` for rows.** A row reads only `[issue, assignee, isSelected]`; marking it shared renders it once for everyone. The development check (render kept regions anyway and compare) never fired, but it made me write deps carefully.
- **W4. URL state** (filters, search, layout) with `ReplaceUrl` + `clientCommands`, and Flags reading it back: copied from the admin example, worked at once.
- **W5. CSS anchor positioning needs no browser code.** Pickers are anchored to the clicked trigger (`anchor-name` on the button, `position-anchor` on the panel), which is what crease's dropdown-menu already does. A server-rendered popover is not a problem when positioning is CSS.
- **W6. crease dropdown-menu works as a server-side Submodel** (the issue page's ⋯ menu), including keyboard navigation on the trigger. crease `button`, `input`, `kbd`, `separator`, the icon set and the theme tokens were used as copied.
- **W7. Islands are small to write.** The keyboard island is a normal Foldkit program using Foldkit's own `Subscription.keyBindings`; contract + client + registration is ~170 lines and needed no change to the framework.
- **W8. Typed text never fights the morph.** Title, description, comment and search inputs are client-owned; other people's edits patch them only when the user is not editing (the Model's draft is null), saving clears drafts without flicker, and Enter/Ctrl+Enter right after typing submits the latest text (the pending-input flush).
- **W9. Testing.** Foldkit's Story tests made update logic easy to pin down (including "the browser posts something made up"), and `@hyper-effect/core/testing` let me test a forged Command-result Message being dropped.
- **W10. Security is the default.** Every bound Message is a ClientMessage; picker choices are re-validated against what the open picker offers, ids are checked, and the store validates assignees and labels again.

## 4. Performance notes

Production mode (`NODE_ENV=production`), one machine (Windows 11 laptop), two Chromium pages in one headless browser, `node scripts/measure.mjs 40`:

| What | median | p95 |
|---|---|---|
| Click a status in the picker → the row's morph arrives, **for the person who clicked** | 17 ms | 19 ms |
| The same click → the morph arrives **for a second person watching the list** | 9 ms | 33 ms |
| Click a row's status icon → picker rendered | 15 ms | 18 ms |
| Click → picker input focused (focus done by the island after the morph) | 32 ms | 35 ms |
| `j`/`k` key → selection moved (key → island → server → morph) | 14 ms | 18 ms |

Development mode for comparison (20 rounds): actor 18 ms, watcher 24 ms (p95 44 ms), picker 15 ms, `j`/`k` 14 ms; the development region checks cost little at this size.

Observations:
- The watcher usually sees the change *before* the actor: the actor's session first handles its own event (post, intake, render of the closing picker) and then the store change; the watcher's only does the latter.
- Everything interactive is a round trip, so on a real network every number above gains the RTT. Locally it feels instant; at 80 ms RTT the picker would open noticeably later than Linear's (which opens without a round trip). Native popovers (`popover` / `popovertarget`, already in Foldkit's attribute set) could open menus with zero latency; I did not use them because Linear's menus need a server-side filter anyway.
- Page sizes: team list 132 kB HTML (12 kB gzip), issue page 35 kB (8 kB gzip); islands bundle 303 kB (100 kB gzip), cached.
- Not measured: many sessions. Each open list re-renders on every change in the workspace (the rows are shared regions, so the cost per extra viewer is mostly the diff and the patch).

## 5. Verdict

**Could someone build a real product on this today?** Yes, for a team-internal or B2B tool with this shape (lists, boards, forms, detail pages, live collaboration), with caveats. The core loop (server-side Foldkit, regions, Subscriptions on a change feed, typed-text ownership, ordered intake) did everything Linear's data model needed, live for every viewer, with almost no code spent on synchronisation, and it was correct on the first try more often than a client app would be. The gaps are all at the edge where a product must feel native: global keyboard handling, focus, menus without latency, client-side navigation and history. Each needed reading the framework's source to find out why something silently did nothing; the skill did not prepare me for them. Production readiness beyond this app would also need a real database (the admin example shows the Postgres pattern) and the load characteristics of many open lists measured.

**Top 5 changes that would help most:**
1. **Declarative global key bindings in core** (F1, F7, F9): accept Foldkit's `Subscription.keyBindings` table (or an equivalent attribute) and render it as a window keydown binding with `whileTyping`, modifiers and `preventDefault` decided in the browser, posting the binding's Message. This removes the most common reason for an island in a serious app.
2. **An explicit, unguarded focus action** (F5): "focus this because the user just asked for it" next to the guarded widget-focus restore, documented in the skill with the click-opens-panel example. Also forward Foldkit UI's `ClickItem` so Combobox/Command Enter works (F2), and make `check:compat` press keys, not only click.
3. **Navigation inside a session** (F13, F14): one program at several paths, a `pushUrl` client action and `popstate` as a Message, so view switches keep the session, scroll and selection and the back button works.
4. **Skill corrections and additions**: drag and drop between server-rendered targets works without an island (F11); a "browser-only behaviours" table (global keys, focus after click, modifier keys, history) with the pattern for each; where Foldkit's docs live in this repo (F3); testing notes (F10, F12).
5. **crease/ui for server-first use**: an `attributes` prop on form controls (F8), a server-friendly command/picker component with a filter input (what this app had to build), and hover state in menus kept in CSS instead of a server round trip per item (crease dropdown-menu posts `ActivatedItem` on every mouse-enter).

## 6. Follow-up (2026-10-27): what changed after the experiment

The friction log led to changes in core, the skill, the template and crease. The app was then moved onto them; everything above describes the experiment as it ran.

| Entry | Now |
|---|---|
| F1, F6, F7, F9: global shortcuts needed a keyboard island | Core's `keyBindings(h, [...])` (Foldkit's grammar, matched in the browser; `message` may be a function of the focused element's id). The island, its Vite build and the 100 kB bundle are gone; `src/app/shortcuts/contract.ts` is the binding table. F9 remains in principle (the table follows the Model one round trip later), and the check has not hit it. |
| F5: forwarded focus refused after a click | A forwarded focus now happens unless focus moved since the user acted. Pages ask for focus with a forwarded `FocusElement` Command (`update` wraps the page's logic in `updateModel`). Focus lands with the morph: 15 ms after the click instead of 32 ms. |
| F2: crease command, Enter does nothing | Core forwards Foldkit UI's `ClickItem` (and its focus and scroll Commands); 14 crease components were affected. The compatibility check now presses keys too, and found a second bug that way: crease menus' key handlers build markup, which failed at event time on the server. Core evaluates handlers in a throwaway builder frame now. |
| F8: no extra attributes on crease form controls | crease `input`/`textarea` take `attributes`; the description editor uses `textarea` with `attributes: [h.OnBlur(...)]`. See `docs/crease-changes.md`. |
| Menus: a request per item hovered | crease `dropdownMenu({ activateOnHover: false })`; the ⋯ menu uses it, and the check verifies 0 requests while hovering. |
| F11: the skill wrongly sent drag and drop to an island | Skill corrected; a new reference `references/browser.md` lists every browser-only behaviour and the way to get it. |
| F3, F10, F12: Foldkit docs location, `serve` path, first stream event | In the skill. |
| F4: `tsx` holding the port on Windows | Template `start` uses `node --import tsx`. |
| F13, F14: one program at several paths, navigation within a session | Open: a design proposal in `docs/design-latency.md`, with the measurement at 80 ms round-trip time. |

The browser check grew to 43 steps (the ⋯ menu: hover sends nothing, choosing works) and passes in development and production mode.

**At 80 ms round-trip time** (`tools/net/shaper.mjs`), every interaction costs the round trip plus about 20 ms: 102 ms for a status change, 99 ms to open a picker, 103 ms for `j`/`k`. Changes to data are acceptable at that; screen-only interactions (menus, selection) are not, which is what the design proposal addresses.

## How to run

```sh
# at the monorepo root, once
npm install
cd apps/linear-clone
npm run build                                   # CSS
PORT=4100 node --import tsx src/main.ts         # development, http://localhost:4100
NODE_ENV=production PORT=4100 node --import tsx src/main.ts   # production mode
npm run typecheck && npm test
node scripts/check.mjs                          # the two-person browser check, against the running server
node scripts/measure.mjs 40                     # click → morph latency (run against production)
node scripts/screenshots.mjs                    # regenerate screenshots/
```

Sign in with any name; "Ada", "Grace", "Linus", "Margaret", "Alan" and "Katherine" are seeded members. Open a second browser (or a private window) with another name to see changes and presence live.
