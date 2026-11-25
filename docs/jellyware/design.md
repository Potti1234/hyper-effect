# Design: extensions for hyper-effect

The proposed architecture in eight parts, what each takes from Graft, bb and Powermove, the changes it needs in `@hyper-effect/core`, and what is still unverified. Nothing here is built yet.

## Overview

| Part | Where it comes from | Lives in |
|---|---|---|
| 1. A page host that adds and removes programs at run time | New | `@hyper-effect/core` |
| 2. A contributions registry with a change feed | Powermove's registry | Extension system |
| 3. Loading code | bb's resolve hook | Extension system |
| 4. Slots in existing pages | bb's declarative UI | Extension system, used by host pages |
| 5. Stylesheets | New | Core (reload) and extension system (build) |
| 6. The agent pipeline | Powermove | Extension system and the app |
| 7. Data and migrations | bb | Extension system |
| 8. Trust | bb and Powermove; Graft `Remote` later | Extension system |

Lifecycle, dependencies, failure, settings and observation come from Graft ([graft.md](graft.md#which-parts-to-use)) and run through all parts.

## What an extension is

A folder `extensions/<id>/` with a manifest and an entry module. The entry exports a `Layer`; its requirements are the host services it uses, and everything it registers is released when its scope closes. A sketch, not a final API:

```ts
// extensions/standup/extension.ts
import { Effect, Layer } from 'effect'
import { Contributions } from '@hyper-effect/jellyware'
import { Tasks } from '@/app/tasks/store'
import * as StandupPage from './page.ts'

export default Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Tasks // a requirement: the extension mounts once the store exists
    yield* Contributions.page(StandupPage.program, { path: '/standup' })
    yield* Contributions.nav({ id: 'standup', label: 'Stand-up', href: '/standup' })
  }),
)
```

```json
// extensions/standup/extension.json
{ "id": "standup", "version": 3, "entry": "extension.ts", "requires": ["tasks"] }
```

The host decodes the manifest with a Schema, imports the entry and calls `Graft.mount(entry, { name: id, requires, retry })`. A page inside an extension is a normal hyper-effect program and follows the rules in the hyper-effect skill.

## 1. A page host in core

`Hyper.layer` (`packages/core/src/server.ts`) does two things in one function: it builds a page's state (sessions, snapshot store, limits) and it registers five routes with `router.add`. Routes cannot be removed, and adding one twice throws ([graft.md](graft.md#what-it-leaves-open)).

Built on the branch `jellyware` (`packages/core/src/page-host.ts`, tests in `packages/core/test/page-host.test.ts`):

1. `Hyper.pageRoutes(program, options)` builds a page's state in the current scope and returns its routes without adding them to a router. `layer` adds them to the app's router as before; existing apps do not change. The Datastar bundle route moved out into `serveDatastar(router)`.
2. `Hyper.pageHost` is a layer providing the `PageHost` service. It keeps the pages mounted now in a router of its own (`HttpRouter.make`), rebuilt on every change, and adds a global middleware to the app's router: a request none of the app's routes matched goes to the host's router. The app's own routes therefore always win, and a path nobody serves still gets 404.
3. `host.mount(program, options)` serves a page for the life of the current scope. Closing that scope removes its routes first, then runs what releasing `Hyper.layer` runs: live sessions close and their snapshots are written.
4. A page mounted under a name that is already mounted shadows the earlier one; closing it reveals the earlier one again. A page whose path collides with another page's fails with `PageConflict`, and what is served stays unchanged.

On a swap (mount the new version, close the old one), the browser's stream ends, Datastar reconnects, and the session is restored from its snapshot under the new program; a test checks this over HTTP. If the new Model Schema cannot decode the snapshot, `readSnapshot` returns nothing (`server.ts`, `Effect.orElseSucceed`) and the session starts again from its URL: the user loses UI state such as a draft, not data.

While both versions are mounted, events go to the new one, which restores the session from the snapshot, but the browser's stream is still connected to the old one until it closes. A swap should therefore close the old version right after the new one is mounted.

The page host is useful without extensions: modules switched on per tenant or by an administrator need the same thing.

## 2. A contributions registry

One service with a change feed, like the existing stores. It holds entries by kind (`page`, `nav`, `slot`, `command`, `setting`) and id. Per id it keeps a stack of entries, each tagged with the owning extension and its version, as Powermove's registry does (`src/renderer/src/kernel/registry.ts`). The top of the stack is the live entry.

- **Registering** is an `acquireRelease` in the extension's mount scope: the entry is pushed, and removed when the scope closes.
- **Swapping a version:** mount N+1 next to N; its entries shadow N's; then unmount N. If N+1 fails to build, N is untouched. Graft alone cannot do this, because one realm allows one provider per key.
- **Overriding a built-in page or entry** is the same shadowing. Disabling the override brings the original back.
- **Pages read the registry** through a Subscription; the change is morphed into open pages like any shared data.

## 3. Loading code

Taken from bb (`apps/server/src/services/plugins/plugin-runtime.ts:171-216`):

- A `registerHooks` resolve hook from `node:module` adds `?gen=<n>` to every file URL under `extensions/<id>/`. Raising `n` makes Node import the whole extension again; files outside the folder keep their single instance.
- `effect`, `foldkit`, `@hyper-effect/core` and the app's own modules (stores, `src/ui`) must resolve to the host's copies. A second copy of `effect` gives different `Context` keys and Schema classes, and requirements would never match.
- The apps run TypeScript through `tsx` (`node --import tsx`), so no bundler is needed on the server.
- Old module generations stay in memory, as in bb. A restart releases them.

## 4. Slots in existing pages

A Foldkit page has a fixed Model and Message union, so code from an extension cannot run inside another page's update and view. Following bb's rule that the host renders everything from declarations:

- A host page declares a slot: `slot(h, 'tasks.sidebar')`, a region whose deps are the registry entries for that slot.
- An extension contributes data to the slot: a title, rows, and actions that name an extension command, such as `{ label: 'Export', command: 'standup.export', args: {...} }`.
- An action posts a host `ClientMessage`, `RanCommand { id, args }`. The host's update checks that the command exists and that the user may run it, decodes `args` with the command's Schema, and runs the command's Effect.
- Anything the declarations cannot express is a page of the extension.

Host code keeps the rules that make pages safe: `ClientMessage` lists, permission checks in update, region deps.

Built (2026-11-24), with two changes to the sketch above:

- **Content is a stream, not data.** A card usually depends on what the page shows (which issue). An extension registers `Contributions.slot({ slot, id, content })`, where `content` maps the page's context (`issueId`, `identifier`, `memberId`) to a stream of `SlotContent` (a title, items with optional links, actions, a note). The page subscribes to `Contributions.slotCards(slot, context)` and keeps the cards in its Model; the extension's code runs in that Subscription, never in update or view. A stream that fails becomes a card saying so.
- **The browser posts a reference, not a command.** An action is `{ label, command, args }` in the card. The page's `ClickedCardAction { cardId, index }` names an action the page shows; update looks it up in the Model and runs `Contributions.run(command, { args, memberId })`. A browser cannot invent a command or its arguments. The command decodes `args` and checks the member's rights itself.

The issue page offers the slot `issue.sidebar` under its properties (`ISSUE_SIDEBAR` and `issueSidebar` in `examples/jellyware/src/app/extensions.ts`). It renders links only to paths of the app. `extensions/related` shows open issues that share a label and an action "Mark urgent"; the browser check opens an issue, clicks it, and sees the priority change on another person's open copy of the issue.

Since 2026-11-24 the issue lists offer two more ([open-work.md](open-work.md#slots-and-what-can-be-customized-built-2026-11-24)): `issues.palette`, the same `SlotContent` shown as entries of the command palette, and `issues.badges`, a second kind of entry (`Contributions.badges`) for short labels on rows and board cards.

## 5. Stylesheets

Tailwind runs once when an app starts (`"css": "tailwindcss -i src/styles.css -o public/styles.css"` in `apps/starter/package.json`), and `Options.stylesheets` is a fixed list rendered into the page head. Classes used only in an extension have no CSS.

- **Build:** publishing an extension runs Tailwind again with `extensions/**` as a source and writes the result under a content-hashed name.
- **Reload:** open pages need the new stylesheet. The current client actions (`packages/core/src/client-commands.ts`) are focus, scroll, URL changes, click and dialogs; none replaces a stylesheet. Core needs either a new client action or a stylesheet link that the page host renders and morphs.

Built (2026-11-23): core's `StylesheetChanges` is a `Context.Reference` holding a stream of stylesheet URLs, empty by default. Every open page's stream forwards it as a Datastar signal; the client loads the new stylesheets and removes the old ones once they have loaded, so the page is never without styles. In the example, `src/app/styles.ts` watches `extensions/`, runs Tailwind again (`src/styles.css` now lists `../extensions` as a source; before, classes used only in an extension had no CSS), and publishes `/styles.css?v=<hash>`; `/styles.css` is served with `no-cache`, so pages loaded later get the current file. The check: a new version that adds `text-lime-600`, a class nothing else uses, recolours the open Stand-up page without a page load.

## 6. The agent pipeline

Taken from Powermove ([prior-art.md](prior-art.md#agent-pipeline)), with hyper-effect's existing checks as validation:

1. **Stage.** The agent works in a copy of `extensions/`.
2. **Snapshot.** When the agent finishes, the stage is copied into a folder the agent cannot write. Everything below runs on that copy.
3. **Validate:** the manifest Schema, `tsc --noEmit`, the extension's Story and Scene tests, a credential scan, and a mount in a separate Graft graph that must reach `Ready`. The agent's list of changed extensions must equal the hash difference.
4. **Swap** under a journal: write `before/` and `next/`, rename, and roll back an interrupted swap at start.
5. **Load** with the registry swap from part 2, then watch a stabilization window: if the mount goes `Failed`, restore `before/` automatically.
6. **Record** the run as a change set with the hashes before and after. Undoing it restores `before/` only while the live tree still has the hash the run produced.

Failures go back to the agent with the report, a limited number of times. The hyper-effect skill is the authoring guide; a generated skill lists the installed extensions, their commands and their slots, as bb's `plugin-commands-skill.ts` does (built as the agent's guide, [open-work.md](open-work.md#the-agents-guide-built-2026-11-24)).

### What is built (2026-11-23)

A first run with pi: the prompt "Add a Triage extension: a sidebar entry 'Triage' and a page at /triage that lists the issues nobody is assigned to and whose status is backlog or todo, newest first. Each row links to the issue and has a button 'Take it' that assigns the issue to me. The list updates live." went live after two attempts in about two minutes (the first failed the typecheck; pi fixed it from the errors). In a browser, the page listed eight issues, and "Take it" assigned one and removed it from the list.

Two problems found on the way: pi waited for input when its stdin was a pipe (now `stdin: 'ignore'`), and runs started before a restart showed as the newest when a check looked for "the newest run" (checks now wait for a new one).

The pipeline is `Changes` in `packages/jellyware/src/changes.ts`; it knows nothing about the agent. The app gives it an `Agent` and its checks (`examples/jellyware/src/app/agent.ts`), and `/extensions` in the example is the page that starts runs and undoes them.

| Step | Built as |
|---|---|
| Stage | `.jellyware/runs/<id>/stage/`, a copy of `extensions/`; the agent's working directory |
| Agent | pi in print mode, file tools only (read, edit, write, grep, find, ls; no shell), model `gpt-6.1-sol` through the `openai-codex` provider; a retry continues the same pi session with what failed |
| Guard | The app's `src/` is hashed before and after the agent works; a change there fails the run |
| Snapshot | `snapshot/`, copied from the stage after each attempt; checks and install use it |
| Checks | Manifest Schema and entry file, a scan for credentials (API keys, private keys, tokens), and an incremental `tsc` of the changed extensions against the app (about 20 seconds once warm) |
| Install | Refused if a live extension changed since staging; `before/` gets copies of the live folders; the run is saved as `installing` (the journal); live folders are made equal to the snapshot by writing files in place; each changed extension is reloaded; one that fails to build is put back and its error goes to the agent |
| Record | `run.json` with the folder hash before and after per extension; undo restores `before/` only while the live hash equals the run's |
| Recovery | At start, a run left `installing` is put back; one left `working` or `checking` is marked failed |

Not built from the list above: a trial mount in a separate Graft graph (the live load with its put-back does that job). The extension's own Story and Scene tests and the comparison of the agent's declared changes with the hash difference were built on 2026-11-24 ([open-work.md](open-work.md#better-checks-built-2026-11-24)).

Credentials: pi and the Codex CLI sign in to the same ChatGPT account, and refreshing an OAuth token rotates it. pi's own stored Codex credential had stopped refreshing for that reason (`pi auth check` reported `invalid`). The agent therefore copies the Codex CLI's current access token into the app's own pi folder (`.jellyware/pi-agent`, ignored by git) before each attempt, without a refresh token, and starts only while the token has an hour left.

## 7. Data and migrations

- Extensions keep state in stores, never in module variables, so it survives a reload.
- Extension tables use append-only migrations whose index is the id and whose hash is recorded, as in bb (`packages/plugin-sdk/src/internal/host-policy.ts`), on the existing Postgres store.
- Session snapshots need nothing new; see part 1.

## 8. Trust

A first version trusts extensions written by the team's agent: they run in the server process. Recovery comes from Graft (`Failed`, `retry`), automatic disabling after repeated failures, and undo per run.

What in-process code can still do: block the event loop, call `process.exit`, read environment variables and secrets, use any host service. This is acceptable for a team's own instance and not for extensions written by end users. For those, the extension runs in a child process, and the services served to it are what it may use. A page in that process cannot share the host's session loop, so either the whole page runs in the child behind a proxied route, or each event crosses the process boundary.

Built on 2026-11-25 ([open-work.md](open-work.md#extensions-in-their-own-process-built-2026-11-25)): the whole page runs in the child behind forwarding routes. Not over Graft's `Remote`, which serves services in one direction per connection (the spawning side is the client); an extension needs both directions, so a small channel over Node's IPC carries calls, streams and scoped registrations each way.

## Changes to `@hyper-effect/core`

1. Split `Hyper.layer` into `pageRoutes` and its route registration (built).
2. A page host with `mount(program, options)` for a scope (built).
3. A way to replace a page's stylesheet in open pages.

Everything else can live outside core ([placement.md](placement.md)).

## Verified in the example (2026-11-23)

`examples/jellyware` runs the Stand-up extension (three files) under `node --import tsx`, Node 26. `scripts/check-extensions.mjs` passes 12/12 in Chromium, and the Linear clone's own check passes 53/53 with the extension loaded.

- **`registerHooks` together with `tsx`.** The resolve hook composes with tsx's loader: a change to `page.ts`, which only the entry imports, is served within a second.
- **Session restore across a swap.** An open Stand-up page shows the new version without a page load, and keeps its state (an unchecked checkbox) through the snapshot. This needed a change in core: closing a page did not end its open streams, and Datastar does not reconnect a stream that ends normally (`retry: 'auto'`). A closing page now fails its streams (`PageClosed` in `server.ts`); Datastar reconnects as after a restart. Chrome logs the broken stream as `ERR_INCOMPLETE_CHUNKED_ENCODING`.
- **Failures.** A version that throws on import keeps the previous version serving. Removing the folder removes the entry from another person's open page; putting it back adds it again.
- **Generations are never reused.** Unloading an extension and loading it again first reused generation 1, a module URL Node had cached from the first version; the loader now keeps counting.

## Unverified

- **Memory per module generation** for a typical extension.
- **Events during a swap.** While both versions are mounted, an event goes to the new version, which restores the session; the old version's final snapshot can then overwrite the newer one. The window is the time between mounting the new version and closing the old one.

## Order of work

1. Core: `pageRoutes`, the page host, HTTP tests that mount, unmount, mount again and swap a page (done).
2. A hand-written extension in an example app: loader, Graft mount, registry, a page and a nav entry; swap it with a browser open (done: `packages/jellyware`, `examples/jellyware`).
3. The staged pipeline and change sets (done: `Changes`, the pi agent, `/extensions`).
4. Stylesheets (done: `StylesheetChanges`, the example's Tailwind rebuild), settings through `Graft.publish`, a page showing what is mounted (the workshop lists the loader's statuses, which follow Graft's mount states).
5. Slots and commands (done: `issue.sidebar`, `extensions/related`). Risks and the rest: [open-work.md](open-work.md).
