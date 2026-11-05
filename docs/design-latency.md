# Design proposal: interactions without a round trip, and navigation within a session

Status: **proposal, for decision** (2026-10-27). Nothing here is implemented yet. It follows from the Linear clone experiment (`apps/linear-clone/EXPERIMENT.md`) and the measurement below.

## The measurement

The Linear clone in production mode, measured with `scripts/measure.mjs`. Over the network it went through `tools/net/shaper.mjs` with 40 ms each way, no jitter or loss.

| Interaction | Locally | 80 ms round trip | Linear |
|---|---|---|---|
| Change a status: the person who clicked sees it | 18 ms | 102 ms | immediately (optimistic), synced in the background |
| The same change, for a second person watching | 12 ms | 105 ms | about the same |
| Open a picker (status, assignee) | 15 ms | 99 ms | immediately |
| Picker input focused | 15 ms | 99 ms | immediately |
| `j`/`k`: the selection moves | 14 ms | 103 ms | immediately |
| Go to another view (sidebar link) | full page load | full page load + RTT | immediately, no reload |

Every interaction costs a round trip plus about 20 ms, which is the design. For changes to shared data that is acceptable: the data must reach the server anyway, and 100 ms is short.

It is not acceptable for interactions that change nothing but the screen: opening a menu, moving a selection, hovering, switching a tab, collapsing a group. These are instant in every native and client-rendered app, and at 80 ms they visibly lag. A product like Linear lives on them.

## Principle

Split interactions into two kinds:
1. **Changes to data** (status, assignee, a comment). They stay as they are: event → server → morph. They may later get an optimistic hint (section 5), but the server stays the authority.
2. **Changes to the screen only** (open/closed, selected, active, expanded, hovered). They should happen in the browser, at once, with the server told afterwards where it needs to know. The view still declares them; there is no hand-written client code.

The server-side Model keeps the screen state too, so a re-render, a restore or another tab is still correct. It is only updated slightly later.

## 1. Menus and popovers that open without a round trip

**What:** render the menu's content closed but present, and open it with the browser's own Popover API: `popover` on the panel, `popovertarget` on the trigger, both attributes Foldkit already has. Opening and closing, Escape and clicking outside are then the browser's, with zero latency. CSS anchor positioning, which crease already uses, places it.

**Server side:**
- The Model does not need to know the menu is open, for most menus.
- Where it must (a picker whose filter runs on the server), the page posts a `toggle` event (`OnToggle`, already bound) after opening. The panel is already visible; the server catches up for what follows.

**Cost:**
- Every menu's markup is in the page from the start, so pages are larger and renders do more.
- Regions keep the cost per change low: a menu region is rendered once and kept until its items change.
- For long pickers (all members, all labels), render the first page of items and let typing filter on the server, as today.

**crease:** `dropdownMenu` and the clone's picker would get a `mode: 'popover'` (or a sibling component) that renders this way. Arrow keys inside the open popover stay server-side Submodel keys for now (one round trip each, as today). See section 2 for moving them into the browser.

**Effort:** small in core (`data-preserve-attr` for the popover's open state, so a morph never closes it). Medium in crease (a popover variant of the menu components).

## 2. Selection and focus that move in the browser

**What:** a small declarative vocabulary for screen-only state, run by the page script, posting to the server afterwards. The first two cases cover most of what Linear needs:
- **A roving selection over a list:** `j`/`k`/arrows move `data-selected` among the elements of a container, in the browser. The server learns the new selection with a debounced Message (`SelectionChanged { id }`), so it can act on `s`, `p` or Enter.
- **Focus moves:** already instant, through `keyBindings` + forwarded focus; it only needs the selection to be local too.

**API sketch:**

```ts
keyBindings(h, [
  { keys: 'J', local: { moveSelection: { within: '#issue-list', by: 1 } }, message: ({ targetId }) => Message.Selected({ id: targetId }) },
])
```

- `local` names an effect from a fixed set, so there is no arbitrary client code.
- The page script performs it immediately and then posts the Message with the outcome (here the newly selected element's id).
- The server applies it like any other event; its render agrees with what the browser already shows, so the morph changes nothing visible.

**Why a fixed set:** each effect is a few lines of page script, tested once, and the view stays the single description of the page. A general client-side expression language would be Datastar's own, and it would split the app into two programs.

**Risk:** the browser and the server can disagree for a moment (a key pressed while a morph arrives). The rule is the same as for client-owned inputs: the server does not overwrite what the browser just did until it has seen the browser's Message (sequence numbers already order this).

**Effort:** medium in core (page script plus a `local` field on key bindings and on `OnClick`).

## 3. Navigation within a session

**What:** moving between views of one app (list ↔ board ↔ My issues ↔ an issue) without a page load, with the back button working.

**Proposal**, following Foldkit's own application programs, which have `onUrlRequest` and `onUrlChange`:
- **One program, several paths:** `Hyper.layer(program, { paths: ['/team/:team', '/my-issues', '/issue/:id'] })`. Today the same program needs one name per path (F13).
- **Internal links** (`h.a` with a same-origin `href`) get a page-script handler: a click posts `UrlRequested { url }` instead of loading. Ctrl-click and middle-click still open a new tab normally.
- **Two new client actions:**
  - `{ pushUrl }`: `history.pushState`, for the server's answer;
  - `{ load }`: for real page changes (already there).
- **`popstate`** (back/forward) posts `UrlChanged { url }`.
- The session stays, with its stream, handler tables and snapshot. The view for the new URL arrives as a normal morph (mostly region patches when the shell is unchanged).
- Programs that stay one page per path need no change.

**Instant feel on top:** the page script can mark the clicked link as pending at once (`aria-busy`, already there) and the shell can stay. The content morph follows after one round trip, as Linear's own data loads do.

**Effort:** medium in core (routing in the layer, two actions, the link and `popstate` bindings, session reuse across paths). It changes `Options`/`layer`, so decide before the 0.1 API freeze.

## 4. Forwarded Commands that report back (dialogs, measuring)

**What:** today a forwarded Command's result Message is dropped. Foldkit UI's dialog cannot work that way: `ShowDialog` reports `SucceededShowDialog` / `FailedShowDialog`, and the dialog's update depends on it. Seven crease components (dialog, alert-dialog, sheet, drawer, command in a dialog, lightbox, mobile-nav) need it.

**Proposal:**
- A forwarding entry may name its result Messages: `{ showModal: '#id', reply: { ok: token(Succeeded), failed: token(Failed) } }`.
- The page script performs the effect and posts the matching token as a normal event.
- `<dialog>` elements get `data-preserve-attr="open"`, so a morph never closes a modal the browser opened.

**Effort:**
- small to medium in core;
- add `ShowDialog` and `CloseDialog` to `foldkitUiCommands`;
- extend the compatibility check to treat a forwarded Command with replies as working.

## 5. Optimistic changes (later, if needed)

For data changes, an optional optimistic hint: the binding names what the browser may show at once (for example a row's status icon). The morph confirms or corrects it.

This needs a per-component description of the predicted markup. That is the most complex item here, and the least necessary: 100 ms for a status change is close to Linear's own sync. Measure with real users before building it.

## Order and acceptance

| # | Item | Changes the API? | Acceptance |
|---|---|---|---|
| 1 | Popover-based menus (core preserve + crease variant) | no (crease adds a mode) | clone pickers open in < 16 ms at 80 ms RTT |
| 2 | Navigation within a session | yes: `paths`, two actions | list ↔ board ↔ issue without reload; back button works; check covers it |
| 3 | Forwarded Commands with replies (dialogs) | small (`ClientAction` gains `reply`) | crease dialog, sheet, command open and close on a server; compat shows them working |
| 4 | Local selection effects | yes: `local` on key bindings and clicks | `j`/`k` in < 16 ms at 80 ms RTT; server agrees after its Message |
| 5 | Optimistic hints | yes | only after measuring with users |

**Recommendation:** 1 and 3 first (small, no API risk, they unblock crease's overlays). Then 2 before the API freeze, because it changes `layer`. Then 4. Leave 5 open.

**Every item is measured the same way:** the clone's `measure.mjs` through the shaping proxy at 80 ms RTT, before and after.
