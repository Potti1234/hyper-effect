# Design: interactions without a round trip, and navigation within a session

Status: **sections 1–4 are implemented** (local effects, forwarded Commands with replies, navigation within a session, prefetch). Section 5 is still open, and section 6 is the longer-term direction. The proposal followed from the Linear clone experiment (`apps/linear-clone/EXPERIMENT.md`) and the measurement below. Every test and measurement behind it is listed in [hardening-log.md](hardening-log.md).

## The measurement

The Linear clone in production mode, measured with `scripts/measure.mjs` through `tools/net/shaper.mjs`: 40 ms each way, no jitter or loss.

| Interaction | Before (80 ms RTT) | Now (80 ms RTT) | How |
|---|---|---|---|
| `j`/`k`: the selection moves | median 87 ms, p95 90 ms | median 0 ms, p95 8 ms | local `select` effect (section 2) |
| Change a status: the person who clicked sees it | median 93 ms | unchanged | data change, stays server-side |
| The same change, for a second person watching | median 95 ms | unchanged | |
| Open a picker (status, assignee) | median 88 ms | unchanged | its content is per-issue and filtered on the server; see section 6 |
| Shortcuts dialog (`?`) | — | styled crease dialog, opened by a forwarded `ShowDialog` | section 4 |
| Go to another list (sidebar link) | full page load | about 150 ms median in a browser loop, same session | section 3 |
| Open an issue | about 158 ms median | about 76 ms median after resting on its row | section 3, prefetch |

Changes to shared data cost a round trip plus about 20 ms, by design: the data has to reach the server anyway. Interactions that change only the screen should not, and now need not.

## Principle

Two kinds of interaction:
1. **Changes to data** (status, assignee, a comment): event → server → morph. The server is the authority.
2. **Changes to the screen only** (open/closed, selected, focused): they happen in the browser at once, and the server is told afterwards with a normal Message where its Model needs to know. The view still declares them; there is no hand-written client code, and no browser-native replacement for crease's styled components.

The server's Model keeps the screen state too, so a re-render, a restore or another tab stays correct. It is only updated slightly later.

## 1. Local effects: a closed vocabulary (implemented)

`packages/core/src/local.ts` defines the effects the page script can run without a round trip:

| Effect | What it does |
|---|---|
| `{ show: '#id' }`, `{ hide: '#id' }`, `{ toggle: '#id' }` | `hidden` and `data-state` on a server-rendered element, `aria-expanded` on its `aria-controls` triggers |
| `{ focus: '#id' }` | moves focus |
| `{ showDialog: '#id', focus? }`, `{ closeDialog: '#id' }` | the dialog runtime of section 4 |
| `{ select: { within, by, items?, attribute?, scroll? } }` | moves `data-selected` among a container's items |

A view attaches them to an event with `local(h, { click: [...] })`, a key binding with `local: [...]`. The page script runs them and then posts the event as usual, so the server's update sees the same Message it would have seen without them. A `select` effect adds the id of the newly selected element to the payload; the Linear clone maps it to an issue (`MovedSelection`) and ignores ids it does not know.

**Reconciliation:** every render carries the position of the last event the server applied (`_ha`). The page keeps its local operations until the server has applied the event that caused them and re-applies them after each morph, so a render the server produced before it saw the event cannot undo what the browser already shows. After that the server's markup is the authority again.

**Why a closed set:** each effect is a few lines of page script, tested once, and the view stays the single description of the page. The effects are JSON in a `data-hyper-local` attribute, parsed and never evaluated, so they add nothing to what the CSP has to allow. A general client-side expression language would split the app into two programs.

## 2. Selection in the browser (implemented)

The Linear clone's `J`/`K`/arrow keys use `select` within `#issue-list`. The browser moves `data-selected` at once and posts `MovedSelection { elementId }`; the server sets `selectedId`, so `s`, `p` or Enter act on the right issue. Stories in `apps/linear-clone/test/issues.test.ts` cover the update; `scripts/check.mjs` covers the page.

## 3. Navigation within a session (implemented)

Following Foldkit's application programs (`onUrlChange`):
- **One Program, several paths:** `Hyper.layer(program, { path, paths, ... })`. The Linear clone serves `/team/:team`, `/my-issues` and `/issues` from one `issues` Program.
- **`Program.onUrlChange(request)`** turns the matched `PageRequest` into a Message (`ChangedUrl` in the clone), or fails with `PageNotFound` / `PageRedirect`, which become a page load.
- **Links:** a same-origin link that matches one of the page's paths is taken on `mousedown`, posted to the session's `/nav` endpoint and pushed with `history.pushState`. Modified clicks, middle clicks, downloads, other targets and external links stay with the browser.
- **Back/forward:** `popstate` posts the current URL the same way.
- **`{ pushUrl }`** is a client action; `{ load }` navigates in the session when the URL matches the page's paths and loads the page otherwise.
- The session keeps its stream, handler tables and snapshot. Programs without `onUrlChange` load pages as before.

**Prefetch:** `prefetch: ['/issue/*']` adds a speculation-rules script (`eagerness: 'moderate'`). A request with `Sec-Purpose: prefetch` (or `Purpose: prefetch`) is rendered from `flags` and `init` but registers no session and runs no init Commands; when the page is opened, its stream starts the session from the URL. A prefetch that is never used therefore leaves nothing behind (`packages/core/test/prefetch.test.ts`).

## 4. Forwarded Commands that report back (implemented)

A forwarding entry may name its replies: `{ action, replies: { ok, failed? } }`. The page performs the action and posts the reply; the server looks it up, lifts it through the Command's `mapMessage` chain and dispatches the root Message. `foldkitUiCommands` maps Foldkit UI's `ShowDialog`, `CloseDialog` and `ReleaseDialogResources`, so crease's styled dialog runs with its update on the server.

The dialog runtime in the page script gives the styled markup what a modal needs: focus moves in and is trapped, Escape cancels, the rest of the page is `inert`, scroll is locked, focus returns on close, and a morph never closes an open dialog. The Linear clone's `?` opens the crease keyboard-shortcuts dialog this way.

Still to do: the compatibility check (`check:compat`) does not count a forwarded Command with replies as working yet, so sheet, drawer, alert-dialog and command-in-dialog are still listed as browser-only there.

## 5. Optimistic changes (open)

For data changes, an optional optimistic hint: the binding names what the browser may show at once (a row's status icon), and the morph confirms or corrects it. It needs a per-component description of the predicted markup, which makes it the most complex item here and the least necessary: 100 ms for a status change is close to Linear's own sync. Measure with real users first.

## 6. Later: crease Submodels running in the browser

The local effects cover open/close, focus and selection. They do not cover components whose screen state is richer: the Linear picker (its items depend on the issue and its filter runs on the server, so opening it is a round trip), a combobox, a date picker, a slider.

The longer-term answer is to run those crease Submodels in the browser with the same Foldkit code, and send only their OutMessages to the server:
- the server renders the component as today, with its Model encoded in the page;
- the browser hydrates that one Submodel and runs its update and view locally, with zero latency for everything inside it;
- its OutMessages (`ChoseItem`, `Closed`, ...) are posted as Messages of the page, which is where data changes happen;
- the page's Model keeps the Submodel's last reported state, so a restore re-renders it.

This keeps the Elm architecture intact (one update per Submodel, Messages as facts) and removes the second "language" that local effects are. It is an island whose Model starts on the server, and it needs from Foldkit:
- a public way to hydrate one Submodel from server-rendered markup and an encoded Model;
- a stable boundary for OutMessages leaving a browser-run Submodel.

Until Foldkit offers those, local effects are the narrow, tested way to keep screen-only state off the network.
