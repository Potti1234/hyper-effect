# hyper-effect guide

The full reference: how the pieces fit together, the mechanisms that keep it correct, security, performance and known limits. Paths are relative to the repository root. For a quick start see the [README](../README.md).


The Elm architecture on the server, on Effect. Pages are Foldkit programs (Model, Message, `update`, `view`, Commands, Subscriptions) whose loop runs in a server session. Views are written with Foldkit's `HtmlBuilder`, so crease/ui components render unchanged. The browser runs Datastar: it posts events and morphs in the re-rendered page. The parts that need client-side reactivity (a map, a canvas, drag and drop) are **islands**: real Foldkit programs in the browser, connected to the server page by two Schemas.

```sh
npm install
npm run create -- my-app # a new app in apps/my-app (then npm install); see packages/create-hyper-effect
npm start                # Dispatch: builds CSS + islands bundle, serves http://localhost:3000
npm run start:cluster    # the same on every core: a router plus one worker per core
npm test                 # vitest, every workspace: builder, session runtime, ordering, HTTP, security
npm run typecheck        # every workspace
npm run check:dispatch   # Chromium, two dispatchers, random 0–300 ms POST latency
npm run check:restart    # kills and restarts the server under an open page
npm run check:browser    # the original greeter spike (/greeter)
npm run check:compat     # renders every crease/ui demo on the server → docs/compatibility.md
npm run start:admin      # the catalog admin on http://localhost:3200
npm run check:admin      # Chromium: two editors and a viewer against the admin
npm run check:cluster    # two Dispatch nodes behind a load balancer, one killed mid-session
npm run check:inputs     # IME composition, autofill and change-only fills on a morphing page (needs npm start)
npm run db:start         # a throwaway Postgres in Docker; prints DATABASE_URL
npm run check:admin-nodes  # two admin processes on one Postgres: live changes, images, conflicts, failover
npm run perf:load -- 200 1 15   # load test: pages, changes per second, seconds
npm run perf:profile     # the same with a CPU profile and its summary
```

Where this is going: [docs/roadmap.md](roadmap.md). What has been measured and what is left to try: [docs/performance.md](performance.md). Running it behind a proxy, on several machines, with compression and Postgres: [docs/deployment.md](deployment.md). Which crease/ui components work on the server: [docs/compatibility.md](compatibility.md).

## Packages

| Workspace | What it is |
|---|---|
| [`packages/core`](../packages/core) (`@hyper-effect/core`) | `Program`, the session runtime, the server `HtmlBuilder`, Datastar bindings, `Hyper.layer`, security, metrics. Test helpers at `@hyper-effect/core/testing`. |
| [`packages/island`](../packages/island) (`@hyper-effect/island`) | Islands: the Schema contract, `Island.view` for server views, `register` for the browser, `islandsBuild` (Vite preset). |
| [`packages/create-hyper-effect`](../packages/create-hyper-effect) | `npm run create -- <name>`: a new app from the template (sign-in, live page, form, regions, tests, browser check). |
| `apps/*` | Apps generated with `create-hyper-effect`; `apps/starter` is the template as generated. |
| [`.claude/skills/hyper-effect`](../.claude/skills/hyper-effect/SKILL.md) | The agent skill: architecture, rules, workflow, API map, patterns with references, pitfalls. |
| [`examples/dispatch`](../examples/dispatch) | The demo below, with crease/ui copied in (`src/ui`, `src/lib`), and the browser checks and load test as scripts. |
| [`examples/admin`](../examples/admin) | A catalog admin: sign-in with roles, search, filters, sorting and pagination synced to the URL, image uploads, edit conflicts, live updates. Tested with Foldkit's Story and Scene. |
| `tools/perf` | Load and profile scripts; see [docs/performance.md](performance.md). |
| `tools/cluster` | A small load balancer (sticky or round-robin), `check:cluster` (two Dispatch nodes on one snapshot store, with failover) and `check:admin-nodes` (two admin processes on one Postgres). |
| `tools/net` | nginx in front of the app (HTTP/1.1 and HTTP/2) and a shaping proxy for bad networks (latency, stalls, resets). |
| `tools/postgres` | A throwaway Postgres in Docker for tests and checks. |
| `tools/compat` | Renders every crease/ui demo through core and writes the compatibility matrix. |

All packages are TypeScript sources (no build step yet) and share one copy of `effect` and `foldkit`.

## The demo: Dispatch

Field incidents around Munich, worked on by several dispatchers at once. Open http://localhost:3000 in two browsers (or a normal and a private window), sign in with two names, and try:

- **Select** an incident in the list (server) and watch the map focus it (island). Click a marker on the map (island) and the list selects it (server).
- **Filter** with the status toggle group. It's a crease *stateful* component (a Foldkit Submodel) running on the server. **Search** as you type.
- **Report** an incident: submit empty to see Schema validation messages, type a title, click the map to place it, then press Enter.
- **Take, resolve, comment** in one window and watch the other update: list, map markers, activity feed, comment thread, and who is "on duty".
- **Restart the server** while a page is open. The page reconnects and keeps its selection and half-typed draft.
- **Sign out** with two tabs open. The other tab is sent to sign in at its next click.

| Path | Program |
|---|---|
| `/` | `src/app/dispatch/board.ts`: list, filter, search, report form, activity, map island |
| `/incidents/:id` | `src/app/dispatch/incident.ts`: details, live comments, read-only map island (404 for unknown ids) |
| `/login`, `/logout` | `src/app/dispatch/auth.ts`: plain routes; a signed, HttpOnly cookie carries the name |
| `/greeter` | `src/app/greeter.ts`: the first spike (public) |

Paths are relative to `examples/dispatch`. The shared state (`IncidentStore`, `Presence`) lives in `src/app/dispatch/store.ts`. In production that would be a database plus a change feed; the pages would not change.

## Three ways a component can live

| | Runs in | Use for | In the demo |
|---|---|---|---|
| **Server-rendered view** | server, re-rendered per change | everything that is markup plus events | crease button, card, badge, input, textarea, empty |
| **Server-side Submodel** | server (`h.submodel`) | stateful widgets whose state is fine to round-trip | crease toggle-group (status filter) |
| **Island** | browser (Foldkit `makeElement`) | browser APIs, high-frequency input, third-party widgets | crease map (MapLibre): pan/zoom/hover never touch the network |

Rules of thumb (the full table for crease/ui is in [docs/compatibility.md](compatibility.md)):
- If a widget needs `OnMount` (measuring, positioning, a third-party library) or reacts per frame or per pointer move, make it an island.
- On the server, `OnMount`/`OnUnmount` are dropped with a warning. Commands that touch browser globals are skipped, and the server logs one warning per Command instead of an error each time.
- Focus Commands of Foldkit UI primitives are **forwarded**: the browser performs them after the morph, so arrow keys work in server-side Submodels. A forwarded focus never pulls focus back from where the user has moved since. Other browser-only Commands need an entry in `Program.clientCommands`.
- Navigation Commands are forwarded the same way. Write them as in a Foldkit app (`Navigation.replaceUrl`, `Navigation.load`) and map them in `clientCommands` to the `replaceUrl` or `load` actions (same origin only). This is how the admin keeps its filters and page number in the URL.

## How it fits together

```
GET /                     Flags (Effect: URL, params, cookies, headers, visitor, store) → init → view
                          → full HTML, works without JS; a session is created and snapshotted
GET /_hyper/<p>/s/:id/stream
                          Datastar opens it on load; every Model change is rendered and the
                          regions that changed are sent as datastar-patch-elements
                          (+ patch-signals for client-owned inputs)
POST /_hyper/<p>/s/:id    data-on:* bindings post events; they become Messages in sequence
                          order, update runs, Commands fork, the stream sends the morph
```

### Regions

A page re-renders on every Model change, but it need not re-render or re-send all of itself. A **region** is one element with an id that renders again only when its deps change:

```ts
region(h, {
  id: 'activity',
  deps: [model.activity],
  render: () => activityFeed(model, h), // one element with h.Id('activity')
})
```

- **Unchanged regions are kept:** a region whose deps are unchanged is not rendered at all. While the markup around the regions is unchanged, the stream sends only the changed regions, each morphed by id.
- **Nesting:** regions nest. A list renders again around its rows and keeps the unchanged ones. Since a region's version changes only when its own markup does, only the changed row is sent.
- **Deps are compared by value:** data arriving in a Foldkit Message is always a copy.
- **Development check:** outside production, every kept region is rendered anyway and compared, so missing deps fail loudly with the field to add.
- **Shared regions:** `region(h, { …, shared: true })` renders once per deps for every session of the program instead of once per session. This is for regions that bind Messages only (a row, a feed); one with function handlers or client-owned inputs fails to render.
- **Keep expensive widgets out of regions that re-render often.** A region re-renders whenever its deps change, so a Submodel with key handlers (probed at render time) inside a list that changes on every store update is rendered again each time. Give it its own region.

On the Dispatch board, regions halve the CPU per change and cut patch bytes by 6.9× (see [the roadmap](roadmap.md#region-patches-2026-10-23)); splitting the incident list so the filter widget sits in its own region halved the remaining work again.

### Uploads

`OnFileChange` and `OnDropFiles` work on the server:
- **Upload:** the page posts the files as multipart, in sequence with the page's other events.
- **Handling:** they reach `update` as web `File`s, as in the browser. A Command reads or stores them; Foldkit's `File.readAsText` and friends work on the server too.
- **Limits:** `limits.maxUploadBytes` (10 MB) and `maxUploadFiles` (10) per upload. Uploads count against the event rate and go through the same owner, origin and principal checks.
- **Model:** keep a reference in the Model (an id in your storage), not the `File`: Models are snapshotted as JSON.

### Keyboard shortcuts and browser effects

```ts
// in the view: page-wide shortcuts, matched in the browser (Foldkit's keyBindings grammar)
keyBindings(h, [
  { keys: 'C', message: Message.PressedCreate() },
  { keys: ['G', 'M'], message: Message.PressedGoToMine() },
  { keys: 'Mod+Enter', whileTyping: 'Allow', message: ({ targetId }) => Message.PressedSubmit({ targetId }) },
])

// on the program: Commands the browser performs after the next morph
clientCommands: { FocusSearch: () => ({ focus: '#search' }) },
```

- **Key bindings:** the table rides on a hidden element. The page script matches each key press with Foldkit's rules (modifiers, sequences, not while typing unless allowed, IME and repeats ignored), and only a matching key posts its Message. It follows the Model like any view: `isEnabled: false` leaves a binding out.
- **Forwarded Commands:** focus, scrolling, the address bar, navigation and clicks are performed by the browser.
  - A focus happens unless the user has moved focus since they acted.
  - Foldkit UI's focus, scroll and item-click Commands are forwarded already, so arrow keys and Enter work in crease's menus, selects, comboboxes and command palette.
- What needs which tool: `.claude/skills/hyper-effect/references/browser.md`.

### Islands

```ts
// contract, shared by server and browser (examples/dispatch/src/app/dispatch/islands/incident-map.ts)
import * as Island from '@hyper-effect/island/contract'
export const IncidentMap = Island.define({ tag: 'incident-map', Props, Event })

// server view (import * as Island from '@hyper-effect/island'): props go down, events come back as Messages
Island.view(IncidentMap, { id: 'board-map', props: mapProps(model), onEvent: event => GotMapEvent({ event }) }, h)

// browser (examples/dispatch/src/client/islands.ts): a Foldkit program with ports { inbound: { props }, outbound: { events } }
import { register } from '@hyper-effect/island/client'
register(IncidentMap, makeIncidentMap)
```

- **Server to island:** the server renders `Props` into the custom element's `data-props`. A morph that changes them reaches the island's inbound Port.
- **Island to server:** the island emits an `Event` on its outbound Port. The custom element re-dispatches it as an `island-event` DOM event, which the server-side view binds and decodes with the Schema.
- **Surviving morphs:** the island's DOM sits inside a `data-ignore-morph` wrapper, so Datastar never touches it, and the island stays alive through every morph (the browser check verifies this).
- **Bundle:** islands are built by Vite (`examples/dispatch/vite.islands.config.ts`, using the `islandsBuild` preset from `@hyper-effect/island/vite`) into `public/assets`. The eager entry is the Effect plus Foldkit runtime (~114 kB gzip); MapLibre is loaded only when a map mounts.

### Framework files

| File | Role |
|---|---|
| `packages/core/src/program.ts` | `Program`: name, `Model` and `ClientMessage` Schemas, effectful `flags(request)`, init/update/view/subscriptions, `onConnectionChange`, `clientCommands`; `PageNotFound`, `PageRedirect` |
| `packages/core/src/builder.ts` | Server `HtmlBuilder`: one per Foldkit builder, bound to the render in progress. Real Foldkit `h.submodel` with a server builder for the child. |
| `packages/core/src/binding.ts` | Foldkit events → Datastar `data-on:*`: Message tokens, handler ids, key probing, pointer and custom events, client-owned inputs |
| `packages/core/src/intake.ts` | Ordered, exactly-once intake of a page's events: a pure state machine, property-tested |
| `packages/core/src/file-store.ts` | `fileStore`: snapshots in files, each replaced whole |
| `packages/core/src/session.ts` | Session runtime: update loop, Commands, forwarding, Subscriptions, handler tables, ordered intake, render |
| `packages/core/src/server.ts` | `Hyper.layer(program, options)`: page, stream and event routes; snapshots; visitor cookie and principal; limits; page script |
| `packages/core/src/security.ts` | Content-Security-Policy, sealed snapshots, client address and host behind proxies, token buckets |
| `packages/core/src/region.ts` | `region(h, { id, deps, render })`: per-session regions, re-rendered and re-sent only when their deps change |
| `packages/core/src/shared.ts` | `shared(h, { key, deps, render })`: markup rendered once per change and reused by every session |
| `packages/core/src/file-reader.ts` | A `FileReader` for the server, so Foldkit's file helpers work on uploads |
| `packages/core/src/client-commands.ts` | Forwarding table: browser-only Commands performed by the page |
| `packages/core/src/streams.ts` | `sampleLatest`: throttle high-churn shared feeds; `memoizeLast`: one Message per change of a shared feed |
| `packages/core/src/deps.ts` | Value comparison of region, shared and snapshot deps |
| `packages/core/src/metrics.ts` | Render, patch, session, memory and event-loop metrics; CPU profiles (`metricsRoutes`, opt-in) |
| `packages/core/src/foldkit-internal.ts` | Foldkit's serializer, until it is public (see the roadmap's upstream asks) |
| `packages/island/src/` | `contract.ts` (browser-safe), `view.ts` (server rendering), `client.ts` (custom element plus `Runtime.embed`), `vite.ts` |

## Correctness mechanisms (each one found by the browser tests)

- **Unforgeable events.** Only Messages in `ClientMessage` can be encoded into the page or decoded from a post. Function handlers (`OnInput(f)`, map events) are capabilities: the browser can only name a handler the server rendered.
- **Ordered intake, exactly once.** Every post carries a per-page sequence number (`q`, the `_hq` signal).
  - The session applies events in that order and parks early arrivals.
  - It skips a gap after 1.5 s, and still applies the missing event once if it turns up late.
  - A retried request is never applied twice.
  - The intake (`intake.ts`) is pure and checked with property tests over generated lossy, reordering and duplicating networks.
- **No lost keystrokes on submit.** Typed values that are still waiting for their debounced post ride along with every event (`p`) and are applied first. Without this, Enter right after typing submitted the old title.
- **Morph versus typing.** Inputs bound to `OnInput`/`OnChange` are client-owned: the morph never writes their value (`data-preserve-attr`). The server patches a signal only when the Model diverges from what the client sent, for example when it clears the field after a save. It never patches while typed values are still on their way into the Model, so a render of a slightly older Model cannot overwrite newer keystrokes.
- **No late duplicates.** A value that already went out with another event is not posted again by its own debounce: arriving after a save, it would refill the cleared field.
- **Requests are never cancelled.** Datastar cancels an element's in-flight request by default, which dropped quick double clicks.
- **Handler tables live for 30 seconds.** A live page re-renders constantly, and an event in flight across several morphs must still mean what the user saw.
- **Sessions survive restarts.** Models are snapshotted (Schema-encoded, sealed when a secret is set) to a `KeyValueStore`, with the intake position and the skipped sequence numbers, so a restored session neither re-applies retried events nor loses its place. `Hyper.fileStore` keeps them on disk and replaces each file whole, so a process killed mid-write never leaves a snapshot that cannot be read. An unknown session restores from its snapshot, or else from its page URL.
- **Lossless failover.** An event is answered only once it is applied and in the snapshot store (`durableEvents`, on by default); events arriving together share one write. Datastar retries a request that fails, with the same sequence number. So when a process dies, every event its page was told about is in the snapshot, and every other one is retried on the process that takes over, which applies it or drops it as a repeat. `packages/core/test/failover-protocol.test.ts` checks this over generated retries, delays and process failures; `npm run check:cluster` kills a worker right after it answered a click, and another while a click is in flight.
- **The connection is a Message.** `onConnectionChange` lets Subscriptions depend on whether anyone is looking. Presence is just a Subscription on `{ me, isConnected }`, and it disappears when the tab closes, not when the session expires.
- **Pending feedback.** Elements with an event in flight get `aria-busy`. When the server takes longer than 150 ms, a thin progress bar appears (`html[data-hyper-pending]`).

## Security

Every session request must come from the browser that opened the page, acting for the same user, and must be sent by Datastar:

- **Session binding:** sessions are bound to the visitor cookie and to the request's principal (`Options.principal`, such as the user in a verified session cookie). Snapshots record both. A request for another principal (signed out, switched accounts) closes the session and reloads the page.
- **Auth in Flags:** Flags see the request's cookies and headers, and fail with `PageRedirect` to send the browser to a login page.
- **Request checks:** session requests require the `Datastar-Request` header and are refused when the browser marks them cross-site. Posts also pass an Origin check, which is proxy-aware with `trustProxy`.
- **Content-Security-Policy:** on by default, with a per-response nonce. `script-src` holds `'self'`, the nonce and `'unsafe-eval'` (Datastar). Add the app's own sources with `contentSecurityPolicy.directives`. The Datastar bundle is pinned with Subresource Integrity.
- **Limits** (all configurable, `Options.limits`): event bodies of 16 kB, 20 events/s per session (burst 40), 5 pages/s per client address (burst 50), 16 sessions per visitor, 20,000 per program. Pages whose stream never connects are dropped after 30 s.
- **Snapshots:** they expire after `snapshotTtl` (1 day). With `snapshotSecret` they are sealed with AES-256-GCM and bound to their session id; a list of secrets allows rotation.
- **Id checks:** session ids are checked as UUIDs before any lookup or store access.
- **Escaping:** user content is escaped by Foldkit's serializer and never enters a Datastar expression, since expressions are built from tokens, ids and base64url literals only.

```ts
Hyper.layer(Board.program, {
  path: '/',
  principal: ({ cookies }) => Effect.succeed(verifiedUser(cookies)),
  contentSecurityPolicy: { directives: { 'connect-src': ['https://tiles.openfreemap.org'] } },
  snapshotSecret: Redacted.make(process.env.SNAPSHOT_SECRET),
  trustProxy: 1, // one reverse proxy in front
})
```

The attack suites run in `npm test`:
- `packages/core/test/security.test.ts`: forged sessions, cross-site posts, oversized bodies, floods, malformed ids, markup injection, Datastar attribute collisions.
- `packages/core/test/hardening.test.ts`: principals, redirects, the policy, page limits, sealed and expiring snapshots, proxies.
- `examples/dispatch/test/security.test.ts`: island props and every Dispatch page.

## Performance

Every open page renders on every change it depends on, so cost grows with pages × changes. One change on the Dispatch board (a laptop, production mode) reaches:

| Pages | 1 process, p95 | Workers (`start:cluster`), p95 |
|---|---|---|
| 200 | about 95 ms | about 70 ms (2 workers) |
| 1000 | about 360 ms | about 220 ms (3 workers) |

A page update costs about 0.2 ms of rendering. The method, every measurement since the first spike, the current profile and the levers still open are in [docs/performance.md](performance.md). The levers in place:
- regions, nested and shared: only changed parts of a page render and travel, and parts every page shows render once;
- several cores: a router sends each session's requests to the worker named in its id (`Options.node`, `nodeOfPath`), and a dead worker's sessions to one heir;
- no stack capture while views render in production (`HYPER_VIEW_STACKS=1` turns it back on);
- `Program.snapshotDeps`: snapshots only when a session's own state changes;
- `memoizeLast`: Messages built once per change of a shared feed, not once per session;
- Subscriptions and snapshot triggers checked right after each update, instead of a stream per session watching every change;
- the direct serializer (Foldkit's validating `renderToString` only outside production);
- conflation per stream;
- one builder per process;
- bounded handler tables;
- `shared` markup for data every page shows;
- `sampleLatest` for high-churn feeds such as presence;
- no render for a Message that leaves the Model unchanged (one that only starts a Command);
- optional per-stream gzip (`compression`): region patches travel about 30× smaller.

## Known limits

- **Browser-only behaviour.** Commands other than the forwarded focus Commands (dialogs, scrolling, waiting for paint) and dropped `OnMount` hooks need a browser. The compatibility matrix lists which components are affected.
- **Events without a binding.** The two `PreventDefault` variants that cannot be decided ahead of time (`OnPastePreventDefault`, `OnBeforeInputPreventDefault`) have no server binding. `PreventDefault` keyboard handlers are probed with common keys at render time.
- **Uploads are buffered in memory** (bounded by the upload limit per request, not by the number of concurrent uploads) and report no progress.
- **Island Schemas should be JSON-plain.** Props travel as JSON in an attribute; Events travel as `CustomEvent` details.
- **Multi-node.** Snapshots make sessions portable, but two processes must not serve one session at once.
  - Route per session: `Options.node` puts the process's name into session ids, and `nodeOfPath` reads it back; `examples/dispatch/src/cluster.ts` is such a router for one machine. Sticky cookies work too. Round-robin breaks sessions, as `check:cluster` shows.
  - A failover loses no answered event (see Lossless failover above), but Commands in flight die with their process: an HTTP call or store write started by an event is not rerun elsewhere. Make such effects idempotent, or record the intent in the Model.
  - A proxy in front must not answer a dead upstream with an error status for session requests: Datastar retries only failed requests. Reset the connection (as Dispatch's router does), or retry on another upstream.
  - App state shared across processes (a database and change feed) is the app's job. The admin on Postgres is the reference (`DATABASE_URL`, LISTEN/NOTIFY); Dispatch relays its store through the primary process, which works on one machine only.
- **`'unsafe-eval'`.** Datastar evaluates its expressions with `Function`; the policy keeps it until Datastar offers a CSP-safe mode.
- **Not tested:** Safari and mobile browsers, Caddy, HTTP/3, Redis (see [docs/deployment.md](deployment.md#not-verified-yet)).
- **Experimental foundations.** Foldkit's `experimental/server` and Datastar's wire format are the foundations here, and both may change.
