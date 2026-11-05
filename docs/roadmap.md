# hyper-effect roadmap: from prototype to framework

Status as of 2026-10-26. The architecture is validated, and phases A (decisions that change the API or protocol) and B (deployable) of the plan are done; the code is not yet a framework. This document records where it stands, which experiments decide whether and how to extract it, and the path to a 0.1 release. Results are added to each experiment as they are run.

## Where it stands

| | State |
|---|---|
| **Packages** | A monorepo since 2026-10-23: `@hyper-effect/core` (`packages/core/src`, 4,291 lines in 19 files: security, regions, uploads and durable delivery included), `@hyper-effect/island` (contract, server view, browser runtime, Vite preset), and two apps, `examples/dispatch` and `examples/admin`. Core was 1,596 lines in 8 files before the experiments. |
| **Proven** | The server-side Elm loop; crease/ui rendered unchanged; server-side Submodels; Foldkit islands; Schema-validated forms; live multi-user state; presence; restart survival through snapshots; ordered events, exactly once and lossless across process failures; several cores with routing per session; sign-in and roles; region patches, nested and shared; uploads; URL-synced in-page state; Foldkit's Story and Scene on server programs. 125 vitest tests (property tests of the intake and of delivery across failures among them) and browser checks at 0 and 300 ms latency (`check:dispatch`, `check:restart`, `check:admin`, `check:cluster`), all with the Content-Security-Policy enforced. |
| **Depends on** | Foldkit's `experimental/server` and internals (vnode shape, `ChildAttribute`, boundary frames); Datastar 1.0.4 attribute syntax. |
| **Missing** | Phase C: a frozen API, docs and a template, the agent test of experiment 6, CI. Untested here: Safari and mobile browsers, Redis, server hardware. |

### Baseline measurements (Dispatch board, one render, before experiment 1)

| Incidents | `renderToString` | view + serializer only | HTML per morph | brotli |
|---|---|---|---|---|
| 7 | 31 ms | 12 ms | 37 kB | 3.2 kB |
| 100 | 117 ms | 17 ms | 245 kB | 4.9 kB |
| 500 | 501 ms | 46 ms | 1.1 MB | 10.8 kB |

A CPU profile puts about 45% of render time, plus most of the garbage collection, inside parse5. Foldkit's experimental `renderToString` re-parses its own output to validate it; hyper-effect's own code is about 1%. Every open page re-renders on every shared change, so render cost multiplies by the number of live pages.

## Experiments

Experiments 1 to 3 could still change the architecture, so they run first.

### 1. Fan-out performance

- **Question:** How many live pages can one core serve, and what does a change cost?
- **Approach:**
  - Add server metrics: renders, render time, sessions, connections, memory, CPU.
  - Write a load generator: N SSE sessions without a browser, plus a driver session that changes shared state at R changes per second.
  - Measure CPU, p50/p95/p99 time from change to morph, and memory per session at N = 50, 200 and 1000.
  - Try these levers:
    - serializing without the validation re-parse (validation in development and tests only);
    - conflating changes per stream (render the latest Model, never a backlog);
    - throttling high-churn feeds such as presence;
    - memoized subtrees (Foldkit `createKeyedLazy`), made shareable by keeping the session id out of event attributes.
- **Done when:** p95 under 50 ms at 200 pages and 1 change per second on one core, and memory per session is known.

### 2. Security basics

- **Question:** Is it safe to expose on the internet?
- **Known gaps:**
  - Anyone holding a session id can post to that session: sessions are not bound to the visitor cookie.
  - There is no Origin check.
  - Payloads, queues and parked events are unbounded.
  - There is no rate limit.
  - Session ids reach the snapshot store unvalidated (key injection into a file-backed store).
  - Nothing caps session creation.
- **Approach:** fix each gap, then add an attack suite: forged session, cross-site post, missing Datastar header, oversized payload, event flood, malformed ids, session-creation flood, markup injection through user content, and data attributes that collide with Datastar plugins.
- **Done when:** every attack in the suite is rejected, and the suite runs in CI.

### 3. Compatibility matrix

- **Question:** Which Foldkit and crease parts work on the server, and which need islands?
- **Approach:**
  - Render every crease component's demo program through the server builder.
  - Classify each one: server-rendered, server-side Submodel, degraded (browser-only hooks dropped), or island required.
  - Smoke-test one interaction for each interactive demo.
  - Spike *client command forwarding*: Commands that only touch the DOM (focus, scroll) run in the browser instead of failing on the server, so keyboard focus works in server-side Submodels.
- **Done when:** a generated table is in the docs, and forwarding has a verdict.

### 4. Bandwidth and network

Measure brotli-compressed SSE (one compression context per stream), real mobile latency and packet loss, HTTP/2, proxies (nginx buffering, CDNs), mobile Safari, IME composition, and autofill on client-owned inputs.

### 5. Correctness proof

Property-based tests of the ordered intake (random reordering, loss, retries) against a pure reference model. Run two server instances behind a load balancer with a shared store, with and without sticky sessions.

### 6. Testing and AI-friendliness

- Run Foldkit's `Scene`/`Story` directly against server programs.
- Build a second, different app (CRUD admin with auth, pagination, uploads).
- Give an agent only the README and conventions, plus a feature task, and measure its error rate.

## Path

1. **Week 1:** experiments 1 to 3. In parallel, ask the Foldkit maintainer for a public serializer (or a validation switch) and a stable injected `HtmlBuilder`.
2. **Week 2, done 2026-10-23:** extract into a monorepo, then harden security (see [the hardening results](#security-hardening-2026-10-23)):
   - `@hyper-effect/core` (program, session, binding, builder, Datastar protocol);
   - `@hyper-effect/island` (contract and browser runtime);
   - a Vite preset for island bundles;
   - Dispatch as `examples/dispatch`, with the browser checks as the end-to-end suite.
### Next steps (agreed 2026-10-23)

In this order. The first one can still change the API, so it comes before anything is frozen.

1. **Region patches** (experiment 1's first lever). **Done 2026-10-23**, see [the results](#region-patches-2026-10-23).
   - A page re-renders and sends only the regions whose inputs changed, as separate morphs by id.
   - Expected 2–5× fewer CPU per typical change, and far fewer bytes. Measured: 2.1× CPU, 6.9× fewer bytes.
   - Done when the load test shows the gain and Dispatch uses regions for its list, map, panels, activity and header.
2. **A second app (experiment 6):** a CRUD admin with login, pagination and uploads. **Done 2026-10-23**, see [the results](#experiment-6-a-second-app-the-catalog-admin-2026-10-23); the agent test moves to 0.1. It must settle:
   - uploads, which have no server binding yet;
   - routing: one program per path, or one program with routes;
   - whether `Program` should share Foldkit's application config shape, so one program can run on either side;
   - whether Foldkit's `Scene`/`Story` run against server programs.
3. **Correctness proof (experiment 5).** **Done 2026-10-26**, see [the results](#experiment-5-correctness-proof-2026-10-26):
   - property-based tests of the ordered intake against a pure reference model;
   - two instances behind a load balancer with a shared store.

The remaining steps (network reality, multiple cores, upstream asks, 0.1) are re-planned below with what experiments 5 and 6 taught.

### Plan after experiment 5 (2026-10-26)

Three phases. Phase A can still change the API or the wire protocol, so it comes before anything is frozen; phase B makes it deployable; phase C is the 0.1 release. The upstream asks run in parallel throughout.

**Phase A: decisions that change the API or protocol**

1. **Experiment 7: multiple cores and session routing.** **Closed 2026-10-26: performance is good enough for now**, see [the results](#experiment-7-multiple-cores-and-cheaper-updates-2026-10-26). Routing per session and the worker setup work, and per-update cost fell about 4×: p95 69 ms at 200 pages with 2 workers, 220 ms at 1000 pages with 3, on this laptop. The 50 ms p95 target was met for p50 only. The run on server hardware waits until a machine is available; the levers not yet tried stay listed in [performance.md](performance.md#levers-not-yet-tried). The original plan:
   - **Route by session, not by browser.** Put a node hint in the session endpoint (for example `/_hyper/<program>/n/<node>/s/<id>`), so any balancer, or a built-in `node:cluster` primary, can send each session's stream and events to its node. Experiment 5 showed per-browser stickiness works, but it ties every tab of a browser to one node.
   - **Workers:** N worker processes sharing the snapshot store. The app's change feed is relayed between workers (Dispatch's store becomes a feed; in production, Postgres `LISTEN/NOTIFY` or Redis pub/sub).
   - **Done when:**
     - `perf:load` reaches p95 under 50 ms at 200 pages on 8 threads, and at least scales near-linearly;
     - a cluster check with round-robin page loads keeps every session on one node and fails over correctly.
2. **Delivery across failover.** **Done 2026-10-26**, see [the results](#phase-a-lossless-failover-and-the-region-review-2026-10-26): an event is answered only once it is durable, and the protocol is property-tested across process failures.
   - **The gap:** snapshots are debounced, so when a node dies, events it applied in its last second are lost. The browser got a 204 for them and does not resend. Experiment 5 made restarts exactly-once from the snapshot's position, not lossless.
   - **Options:**
     - snapshot before acknowledging (one store write per event);
     - an event log per session (append Messages and replay them; natural for the Elm architecture, but Commands and Subscription Messages need care);
     - the page resending unacknowledged events with their sequence numbers (needs acknowledgement through the stream).
   - **Choose one**, measure it, and extend the intake properties to restart scenarios.
3. **Region API review.** **Decided 2026-10-26**, see [the results](#phase-a-lossless-failover-and-the-region-review-2026-10-26): sharing stays explicit and is now checked across sessions; deps outside `view` wait, as an additive option. Before the API freezes, decide:
   - cross-session region rendering (`region({ shared: true })` or automatic for regions that bind only Messages);
   - whether deps can live outside `view`, so an unchanged frame skips rendering entirely (see [performance.md](performance.md#levers-not-yet-tried)).

**Phase B: deployable**

4. **Experiment 4: network reality.** **Done 2026-10-26** (Safari not tested), see [the results](#phase-b-deployable-2026-10-26).
   - brotli per stream, against today's ~6 kB region patches;
   - nginx and Caddy buffering configurations, HTTP/2;
   - mobile Safari, IME composition and autofill on client-owned inputs;
   - packet loss and long latency, with the check scripts' latency injection plus OS-level shaping.
5. **Real persistence.** **Done 2026-10-26** with Postgres (Redis not tested), see [the results](#b5-real-persistence).
   - a `KeyValueStore` on Postgres or Redis for snapshots, with native expiry (today's TTL refuses old snapshots but cannot delete them);
   - the admin's store on a database with a change feed, as the reference for app state across nodes.
6. **More load and soak tests.** **Done 2026-10-26**, see [the results](#b6-load-and-soak).
   - the admin under load (its lists re-query on every change);
   - memory over hours;
   - concurrent large uploads.

**Phase C: 0.1**

7. **API freeze:** naming review, built and versioned packages (today they are TypeScript sources), Datastar pinned.
   - **Decided 2026-10-27:** MIT licence; the repository goes to GitHub (later).
   - **Publishing:** Changesets in alpha pre mode, a Release workflow that publishes `@hyper-effect/core`, `@hyper-effect/island` and `create-hyper-effect` from built `dist` with provenance, and a CI job that runs `npm create hyper-effect` from the packed tarballs outside the monorepo. See [releasing](releasing.md). The npm organization `hyper-effect` exists.
   - **Names, checked 2026-10-27:** on npm, `hyper-effect`, `create-hyper-effect` and the `@hyper-effect` scope are free. `hypereffect.com` is registered (since 2014, Namecheap, default name servers). Not registered: `hyper-effect.com`, `hypereffectjs.com`, `hypereffectts.com`, `hyper-effect-ts.com`, `usehypereffect.com`, `gethypereffect.com`, `hypereffecthq.com`, `hypereffectdev.com`, `hypereffectframework.com`.
8. **Docs:** a guide (concepts, regions, security, uploads, deployment with session routing) and an API reference.
9. **`create-hyper-effect`:** a template with one page, sign-in, a region and tests. **Done 2026-10-27:** `packages/create-hyper-effect`, generated as `apps/starter` (4 tests, browser check 11/11), see [the results](#phase-c-part-1-template-agent-skill-and-a-linear-clone-2026-10-27).
10. **Agent skill and lint rules.** **Skill written and tested with an agent building a Linear clone, 2026-10-27**, see [the results](#phase-c-part-1-template-agent-skill-and-a-linear-clone-2026-10-27). Lint rules are open; the agent test should be repeated once the latency proposal is decided.
    - Start from Foldkit's oxlint plugin; add hyper-effect rules (region deps, no browser globals in Commands).
    - Experiment 6's agent test is the acceptance check: an agent with only the docs builds a feature, and its error rate is measured.
11. **CI:**
    - typecheck and vitest;
    - the browser checks (dispatch, restart, admin, cluster);
    - the compatibility matrix;
    - a performance smoke threshold.

**In parallel:** the upstream asks below.
- **Foldkit:** `captureCallSite`, a public serializer, the injected `HtmlBuilder`, a `Dom` service.
- **crease:** `id` props, the base layer, the kbd demo.
- **Datastar:** a CSP-safe expression mode.

## Upstream asks

- **Foldkit:**
  - a public `serializeHtml`, or `renderToString({ validate: false })` ([draft issue](upstream/foldkit-public-serializer.md));
  - the injected `HtmlBuilder` and `ChildAttribute.boundaryMappers` as supported API;
  - possibly an official hook for how events are bound;
  - no `captureCallSite` stack traces for every Submodel on every render in production;
  - `Dom` operations as an Effect service (experiment 3).
- **crease/ui:**
  - ship the base layer with `crease-theme` (done locally, uncommitted);
  - fix the kbd demo markup;
  - an optional `id` on `card` (and other containers), so they can be regions (added to the copy in Dispatch).
- **Datastar:** none so far. Pin the version and track the attribute syntax.

## Results

Every performance measurement, the method, the current profile and the levers not yet tried are collected in [performance.md](performance.md).

### Experiment 1: fan-out performance (2026-10-23)

**Tooling added:**
- `metricsRoutes` (opt-in, `HYPER_METRICS=1`): renders, render time percentiles, patch bytes, sessions and connections per program, event-loop lag and utilization, and memory after GC with `--expose-gc`;
- `POST /_hyper/metrics/profile?seconds=N`, which captures a CPU profile of the running server;
- `scripts/load-test.mjs`: N browser-like sessions (page GET, cookie, SSE stream) plus a driver that changes shared state R times per second. It measures the time from change to morph for every page.

**Levers, in the order the measurements demanded them:**

| Lever | Effect |
|---|---|
| Direct serializer: Foldkit's validating `renderToString` only outside production, with byte-identical output enforced by `test/render.test.ts` | Render 18.8 → 1.8 ms. At 50 pages: p50 562 → 66 ms, CPU 105% → 16%. |
| One server builder per process, bound to the render in progress through a frame stack (instead of 200 closures per render) | Heap per session 3.5 MB → 285 kB. The handler tables had been keeping every render's builder alive. |
| Handler tables bounded by count (16) as well as time (30 s) | Memory stays bounded under render storms. |
| Presence sampled (`sampleLatest`), header capped at 5 names plus a count | 200-page connect storm: 20,503 → 800 renders, 56 → 1.3 s. |
| Conflation per stream (sliding buffer of one) | Never a backlog: under overload, updates merge instead of queueing. |
| `shared` markup (rendered once per change, spliced in after serialization) with the session id moved out of bindings into a signal | Board render with 100 incidents: 3.2 → 0.8 ms; with 500: 22.8 → 3.1 ms for every page after the first. |
| Snapshots debounced to a quiet second | Fewer store writes. Snapshot cost is negligible in profiles. |

**Rejected:**
- **Render pacing by event-loop lag, then by utilization.** It delayed healthy fan-outs: p95 rose to 2.1–2.3 s with missed updates. Conflation already prevents backlogs; overload protection needs admission control instead.
- **Sharing markup through `InnerHTML`.** Foldkit's serializer re-parses InnerHTML to validate it, which costs more than rendering the rows.

**Final numbers** (Dispatch board, one core, production mode, 1 change/s unless stated):

| Pages | Update latency p50 / p95 | CPU | Heap per session | Notes |
|---|---|---|---|---|
| 50 | 123–140 / 240–260 ms | 26% | ~310 kB | |
| 200 | 366 / 751 ms | 71% | ~255 kB | 0 missed updates |
| 1000 (0.5 changes/s, presence every 30 s) | 1,638 / 3,247 ms | saturated | ~240 kB | 955 updates merged by conflation; connect 19 s |

**Cost model:**
- A page update costs about 2–3 ms of CPU under load: rendering about 66%, the serializer about 12% of that, the rest SSE transport (`writev`) and the Effect stream pipeline.
- The same render takes about 1 ms in a warm loop. Under load, colder caches and garbage collection triple it.
- One core therefore serves about 300–450 page updates per second, and latency for the last page equals pages × cost.

**Verdict: the target (p95 under 50 ms at 200 pages, 1 change/s, one core) is not met.** It needs about 15× more throughput per change. The architecture holds: cost is linear and predictable, memory is small, and overload degrades by merging updates rather than failing. The remaining levers, by expected gain:
1. **Region patches.** Render and send only the regions whose inputs changed (Datastar patches by id), and keep per-region inputs to skip unchanged regions entirely. Expected 2–5× for typical changes, and far fewer bytes.
2. **Multiple cores.** Shard sessions across worker processes behind sticky routing, with a shared change feed. Close to linear.
3. **Upstream Foldkit:**
   - a public serializer;
   - no `new Error()` stack capture for every Submodel on every render in production (`captureCallSite`, about 4% of busy time).
4. **A leaner per-connection pipeline:** fewer stream operators per patch.

**Design lesson:** any shared feed rendered into every page (presence, global counters) costs pages × render per change. Sample such feeds, render them as shared markup, or give them their own region.

### Experiment 2: security basics (2026-10-23)

**Implemented in `server.ts`, configurable through `Options.limits`:**
- **Session binding:** sessions are bound to the visitor cookie. Snapshots record their owner, and a restore for another visitor is refused.
- **Request checks:** stream and event requests require `Datastar-Request: true` and the visitor cookie. Posts also pass an Origin check (same host, or `allowedOrigins`).
- **Id checks:** session ids must be UUIDs before any lookup or snapshot-store access. This closes key injection into a file-backed store.
- **Size limits:** event bodies are capped (16 kB, by content length and by Effect's `MaxBodySize` while reading), as are unsent input values per event (32).
- **Rate limit:** a token bucket per session, 20 events/s with a burst of 40.
- **Session caps:** 16 sessions per visitor (opening more closes their oldest) and 20,000 per program (503 beyond). Pages whose stream never connects (crawlers, prefetch) are dropped after 30 s.
- **Cookie:** `Secure` behind HTTPS (`x-forwarded-proto`).

**Attack suite** (`test/security.test.ts`, runs in `npm test`):
- forged session from another browser;
- missing cookie;
- another visitor restoring a snapshot;
- cross-site post;
- missing Datastar header;
- oversized body and too many pending inputs;
- an event flood (some 429s, the owner still served);
- malformed and path-traversal session ids;
- a session-creation flood;
- markup injection: hostile text in text, attributes, Message payloads, client-owned inputs and island props, checked by parsing the output with parse5 in both render modes;
- Datastar plugin attributes in rendered pages that hyper-effect did not emit.

**All attacks are refused. Verdict: done for the basics.**

**Remaining risks to address before production** (all addressed in the [hardening](#security-hardening-2026-10-23) below):
- **Auth:** `PageRequest` exposes only `visitorId`. Apps need request cookies and headers in Flags, plus a redirect error.
- **Page-load flooding:** page GETs create sessions and are limited only per visitor. Per-IP limits belong at the edge.
- **Content Security Policy:** Datastar evaluates expressions with `Function`, so pages need `'unsafe-eval'`. hyper-effect also inlines its page script, which needs a nonce.
- **Snapshots:** they hold Model data, possibly personal data. They need a TTL, and encryption when the store is shared.
- **Origin checks behind proxies:** these rely on the `Host` header. Behind a proxy, configure `allowedOrigins` or trust forwarded headers explicitly.

### Security hardening (2026-10-23)

**Implemented in `packages/core/src/security.ts` and `server.ts`:**
- **Auth:**
  - `PageRequest` carries the request's `cookies` and `headers`. Flags can fail with `PageRedirect({ location, status? })`: a page GET answers 303 (the visitor cookie is still set), and a live page whose session is recreated navigates there.
  - `Options.principal(request)` names who a request acts for. A session is bound to the principal that opened it, and snapshots record it. A stream or event acting for anyone else closes the session and reloads the page, so Flags decide again. Signing out in one tab therefore ends that user's other tabs at their next event.
- **CSP:**
  - Every page response carries a `Content-Security-Policy` with a fresh nonce. The nonce covers hyper-effect's inline script and style, the Datastar bundle and the app's scripts.
  - `script-src` adds only `'self'` and `'unsafe-eval'`, which Datastar needs. Style attributes stay allowed (`style-src-attr`).
  - Also set: `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'`, `form-action 'self'`, and `X-Content-Type-Options: nosniff`.
  - Apps add sources per directive (Dispatch adds OpenFreeMap to `connect-src`), switch to report-only, or turn the policy off.
  - The default Datastar bundle is pinned with Subresource Integrity.
- **Page limit per client:** a token bucket per client address (5 pages/s, burst 50) covers page GETs and sessions recreated after a restart. Recreated sessions now also respect the session caps; before, a stream for an unknown id could create sessions past them.
- **Snapshots:**
  - `snapshotTtl` (1 day by default) discards older snapshots, and live sessions refresh theirs.
  - `snapshotSecret` seals snapshots with AES-256-GCM. Keys are derived with HKDF per program, and the session id is bound in as associated data. A list of secrets rotates them: the first seals, every one opens.
  - With a secret set, plain, tampered, moved or foreign snapshots are refused.
- **Proxies:** `trustProxy: n` reads the client address and host from the entry the n-th proxy appended to `X-Forwarded-For` / `X-Forwarded-Host`, not from entries the client could forge. Without it, both headers are ignored. Session requests that the browser marks `Sec-Fetch-Site: cross-site` are refused, unless their Origin is in `allowedOrigins`.

**Tests:**
- `packages/core/test/hardening.test.ts`, 17 tests: redirects; principal changes on events, streams, recreation and snapshots; the policy, its nonce, report-only and off; page limits with and without trusted proxies, including a forged `X-Forwarded-For` entry; recreation within the caps; sealing, wrong secret, no secret, expiry, tampering, a moved snapshot, rotation, no downgrade; origins behind proxies; `Sec-Fetch-Site`.
- Breaking the associated data or the forwarded-entry choice makes the matching tests fail.
- `check:dispatch`, now 24 checks:
  - sign in through the redirect;
  - the policy header;
  - sign out ending another tab's session;
  - no console errors, with CSP violations reported explicitly.
- `check:restart` passes with sealed snapshots on disk.

**Dispatch demo:**
- Sign-in by name in an HMAC-signed, HttpOnly cookie; `/login` and `/logout` are plain routes with their own Origin check.
- The dispatcher name in presence and comments is the signed-in name.

**Load:** 200 pages at 1 change/s give a p95 of 615 ms and a render mean of 2.1 ms (751 ms and 2–3 ms before). The hardening costs nothing measurable.

**Still open:**
- No CSRF token beyond Origin, `Sec-Fetch-Site` and the `Datastar-Request` header. That suffices for browsers that send Origin on POST, which all current ones do.
- Expired snapshots are refused but not deleted: `KeyValueStore` cannot list keys. Use a store with native expiry, or a periodic cleanup.
- `'unsafe-eval'` stays until Datastar offers a CSP-safe expression mode.

### Experiment 3: compatibility matrix (2026-10-23)

`npm run check:compat` renders every example of all 121 crease/ui component pages through the server builder, with Foldkit's validation on, plus one smoke interaction each. The generated table is in [compatibility.md](compatibility.md).

| Tier | First run | After new bindings and forwarding |
|---|---|---|
| Static | 19 | 19 |
| Server-rendered, interactive | 21 | 31 |
| Server-side Submodel | 14 | 31 |
| Degraded (browser-only part missing) | 22 | 37 |
| Island required | 44 | **2** |
| Error | 1 | 1 |

**What moved components out of "island":**
- **Pointer events** (`OnPointerDown/Up/Move/Leave`, posted with their data; move throttled). These were 37 of the 44, coming from Foldkit UI primitives in menus, popovers and tooltips.
- **`OnCancelPreventDefault`** (dialogs).
- **`OnLoad`, `OnContextMenu`, focus enter/leave, touch, animation, media, clipboard and drag events.**
- **`OnToggle`, `OnBeforeInput`, `OnCopyText`/`OnCutText`.**
- **`OnKeyDownFocus`.** Probing yields each key's focus target, so the browser moves focus immediately.
- **Message binding with a fallback:** a valid ClientMessage that isn't JSON-encodable is bound as a session handler instead of failing.

**Still island:** file inputs (`OnFileChange`); upload support is future work.

**Degraded:** dropped `OnMount` (23 components: positioning, measuring, third-party widgets) and browser-only Commands: `WaitForPaint` (13), `ShowDialog` (9), `FocusOption`, `FocusInput`, scrolling.

**Error:** one kbd demo nests markup the HTML parser restructures. That's a crease markup issue Foldkit's validation catches, and it would also break Foldkit's own hydration.

**Client command forwarding, verdict: works, but needs an upstream change to scale.**
- **Mechanism:** a forwarded Command is not run on the server. Its browser effect travels with the next morph (a signal patch the page script runs after the morph).
- **Verified end to end:** with Foldkit UI's `FocusTab` built in, arrow keys move focus in the server-side toggle-group, and Enter selects (`check:dispatch`).
- **Guard needed:** a forwarded focus arrives a round trip late and stole focus from the search box in the browser test. It is now applied only while focus is still inside the same widget.
- **Why it doesn't scale today:** forwarding needs a table that mirrors Foldkit UI's internal id conventions, because `Dom.focus` touches `document` directly. Commands whose result Message matters cannot be forwarded this way.

**Upstream asks this produced:**
- **Foldkit:** `Dom` operations as an Effect service, so a server runtime can provide a forwarding implementation and every focus, scroll and dialog Command works without a table.
- **crease:** fix the kbd demo markup.

### Region patches (2026-10-23)

**API:** `region(h, { id, deps, render })` in `@hyper-effect/core`, next to `shared`.
- `render` returns one element with `h.Id(id)`. The view gets a placeholder, filled in after serialization.
- `deps` are compared by value (`deps.ts`). By reference would not work: Foldkit's Message constructors copy their payload, so store data arriving through a Message is new objects every time.

**Session (`session.ts`, `region.ts`):**
- **Kept:** a region whose deps are unchanged is not rendered. It keeps its markup, its handler table and its client-owned inputs, and the regions nested in it.
- **Re-rendered:** a region whose deps changed renders, and its nested regions are evaluated again.
- **Versions:** a region's version changes only when its own markup changes, with nested regions as placeholders and handler ids ignored. When the markup comes out identical, the page keeps it and its handler ids are mapped onto the fresh handlers. So the incident list renders again around one changed row, and only the row is sent.
- **Handler tables** are kept while their markup is on the page, and for 30 s (or 64 newer tables) after it was replaced. Before, it was 30 s or 16 renders after creation, which an unchanged region would have outlived.
- **Development check:** outside production, every kept region is rendered anyway and compared, and the nested regions of a kept region must have unchanged deps too. Missing deps fail the render with a message naming the region and the field to add.
- **Inside `shared` markup**, which every session reuses, a region renders in place.

**Stream (`server.ts`):**
- Each connection remembers the frame (the root with region placeholders), the title and the region versions it last sent.
- While the frame is unchanged, a patch carries only the changed regions, skipping those whose changed ancestor carries them anyway, plus the title if it changed.
- A changed frame, or a new connection, gets the whole root as before.

**Dispatch:**
- The board has regions for the header, the incident list with a nested region per row, the map island, the selection panel, the report form and the activity feed. The frame around them never changes.
- The activity feed also uses `shared`, which now saves its render across sessions as well.
- The incident page has regions for the header, the details, the comments and the map.

**Results** (production build, 1 change/s, presence sampled every 2 s, same machine and driver as experiment 1):

| | before | regions | change |
|---|---|---|---|
| 200 pages: p95 / p50 latency | 615 / 345 ms | 330 / 140 ms | 1.9× / 2.5× |
| 200 pages: render mean | 2.1 ms | 0.93 ms | 2.3× |
| 200 pages: CPU | 64% | 31% | 2.1× |
| 200 pages: patch bytes | 7,545 kB/s | 1,101 kB/s | 6.9× |
| average patch | ≈38 kB | 6.4 kB | |
| 1000 pages: p95 latency | 3,247 ms (at 0.5 changes/s) | 1,318 ms (at 1 change/s) | |

- **Per render:** 3 regions are kept, 1 renders to identical markup (the list around the changed row), and 3 render new markup (the row, the map props, the activity).
- **Verdict:** done. The gain is at the low end of the expectation for CPU and above it for bytes.
- **The p95 target (50 ms at 200 pages) is still not met.** At 200 pages the server is idle two thirds of the time. The latency is the fan-out burst: one change renders every page back to back, at about 1.6 ms each including the patch write.
- **Remaining levers, by expected gain:**
  1. multiple cores (Path step 5);
  2. sharing a region's render across sessions when its deps are equal and it binds only Messages (like `shared`, but per region, automatically);
  3. Foldkit's per-Submodel stack capture (`captureCallSite` plus stack preparation, about 6% of busy time).

**Tests:**
- `packages/core/test/region.test.ts`, 12 tests:
  - kept, re-rendered and nested regions;
  - unchanged markup keeping its version and handler ids;
  - handler tables outliving 80 renders;
  - regions leaving and returning;
  - misuse: duplicate ids, a missing id, `>` inside attribute values;
  - the development check, flat and nested;
  - regions inside `shared`;
  - region-only and whole-page patches, and one changed row, on a real stream.
- `packages/core/test/deps.test.ts`: value comparison.
- Breaking the same-markup rule, table pinning or region-only sending makes the matching tests fail.
- All browser checks pass in development mode, so with the deps check active on every render.

**Also fixed:** four tests waited a fixed 1.3 s for the snapshot debounce and failed now and then under parallel load. They now poll the store (`waitForSnapshot` in `@hyper-effect/core/testing`).

### Experiment 6: a second app, the catalog admin (2026-10-23)

**The app** (`examples/admin`, about 1,700 lines of app code):
- **Data:** a product catalog with 240 seeded products in an in-memory store with a change feed.
- **Sign-in** with two roles: editors change the catalog, viewers only look. Flags redirect or answer 404, the session is bound to the user, and `update` checks the role before every write.
- **List:** search as you type, category and status filters, column sorting and pagination. All in-page, mirrored into the URL with `history.replaceState`; Flags read it back, so links and reloads work.
- **Editor:** a Schema-validated form, image upload by picker or drop (stored by reference, checked by magic bytes, served without script), save with optimistic concurrency (an edit conflict is shown live, and nothing is overwritten), and delete with confirmation.
- **Live:** other editors' changes show up in lists and open editors.
- **Regions:** header, toolbar, results with a nested region per row, pager, form, actions, image panel, conflict notice.

**What it forced into the framework:**
- **Uploads:** `OnFileChange` and `OnDropFiles` have a server binding.
  - The page script posts the files as multipart, with the event's sequence number (uploads keep their place among events) and the unsent input values.
  - The upload route has the same checks as events (owner, origin, principal, rate), plus `limits.maxUploadBytes` (10 MB) and `maxUploadFiles` (10).
  - Files reach `update` as web `File`s.
  - A server `FileReader` lets Foldkit's `File.readAsText`, `readAsDataUrl` and `readAsArrayBuffer` work unchanged in Commands.
  - In the compatibility matrix, crease's File Input moves from "island required" to "degraded": only its click-to-open Command is skipped. No crease component requires an island now.
- **Navigation actions:** forwarded Commands can now produce `replaceUrl` (URL-synced in-page state) and `load` (navigate). Both are limited to the page's own origin. Apps keep writing Foldkit's `Navigation.replaceUrl` / `load` Commands and map them in `clientCommands`.
- **Portable regions:** `region()` renders in place under Foldkit's own builder, so views with regions run in Scene tests and in a browser runtime.
- **One form for handler ids:** upload bindings wrote their handler id differently from all others. The development deps check reported it on the first page load: the render failed, naming the region. The check ignores handler ids, and it had not recognised this form.
- **crease asks:** an optional `id` on `table` parts (as on `card`), so they can be regions.

**The four questions:**
1. **Uploads: settled.**
   - Files are buffered in memory, bounded by the byte limit. Large files would want streaming to storage.
   - There is no progress reporting.
   - The File Input's click-to-open Command could be forwarded as a `click` action. Browsers require recent user activation for that, which a round trip may outlast.
2. **Routing: one program per path.**
   - Each page has its own Flags (authorization, data loading), session and snapshot, so a viewer is turned away by Flags before any state exists.
   - Navigation between pages is a page load, which costs one request on a server-rendered page.
   - State inside a page (filters, page number) lives in the Model and is mirrored into the URL, so the URL stays the source of truth on reload.
   - One program with routes would make every session hold every page's state and move authorization from Flags into `update`.
   - The costs: shared chrome is a function called by each program, and state across pages lives in the store or the URL. Client state that must survive navigation (a player, a draft across pages) is an island's job.
3. **`Program` shape: separate, but compatible.**
   - Its Foldkit part (`Model`, `init`, `update`, `view`, `subscriptions`) type-checks against Foldkit's `ApplicationConfigWithFlags`; a compile-time check is in `examples/admin/test/list.test.ts`.
   - Server-only additions: `name`, `ClientMessage`, request-aware `flags`, `onConnectionChange`, `clientCommands`.
   - Browser-only parts (container, ports, routing, devTools, crash and slow UI) mean nothing on the server.
   - One shared config type would need Foldkit to accept request-aware Flags; not worth it now.
4. **Scene and Story: they work unchanged** against server programs.
   - `examples/admin/test` has 14 tests: update flows with Command resolution, role checks, validation, the image flow (including `Scene.changeFiles`) and conflicts.
   - Limits: Scene sees Foldkit's vnodes, where some attributes are DOM properties (`readonly`). Server-only behaviour (handler tables, regions, uploads over HTTP, ordering) stays with core's HTTP helpers and the browser checks.

**Checks:**
- `check:admin`: 24 checks, which pass at 0 and 300 ms POST latency with no console or CSP errors:
  - sign-in;
  - pagination, search, filter and sort, all in the URL, and a reload;
  - validation, save, and a live list update;
  - upload by picker and by drop, and a rejected non-image;
  - an edit conflict;
  - create and delete;
  - the read-only viewer.
- Core: 6 upload tests (binding, HTTP upload read with Foldkit's helper, drop, limits and refusals, the server `FileReader`) and a region test for upload bindings.
- Dispatch's browser checks still pass.

**Not done:** the agent test (an agent with only the README and conventions builds a feature; measure its error rate). It moves to 0.1, where the docs and the agent skill it would test are written.

### Phase C, part 1: template, agent skill, and a Linear clone (2026-10-27)

**Built:**
- `create-hyper-effect` (`npm run create -- <name>`, apps in `apps/`), generated as `apps/starter` (4 tests, browser check 11/11);
- the agent skill `.claude/skills/hyper-effect` (rules, workflow, API map, patterns, pitfalls, and now a table of browser-only behaviours).

**The experiment.** A fresh agent with only the skill, the template and the repository built a Linear clone (`apps/linear-clone`, record in its `EXPERIMENT.md`):
- **Result:** all of Tier 1 and Tier 2 (list grouped by status, filters in the URL, create dialog, issue page, live updates and presence, board, keyboard-first), plus drag and drop and dark mode, in about 47 minutes.
- **Checks:** 24 tests, and a two-person browser check passing in development and production.
- **Friction:** 15 entries, all at the edge where an app must feel native: global keys, focus, menus, navigation.

**Fixed from the friction log, in core:**
- `keyBindings(h, [...])`: page-wide shortcuts matched in the browser with Foldkit's grammar; a binding's Message may depend on the focused element.
- A forwarded focus now happens unless the user moved focus since acting (it was refused after any click).
- Foldkit UI's `ClickItem`, `FocusInput`, `FocusButton`, `FocusItems` and `ScrollIntoView` are forwarded, and a `click` action exists. Enter now works in 14 crease components (command, combobox, select, …).
- Event handlers run in a throwaway builder frame: crease menus' key handlers build markup, and failed at event time on a server. The compatibility check's new keyboard pass found this; menu arrow keys in five components were affected.
- The test helper `serve` provides a program's services; `openPage` keeps the visitor cookie next to a sign-in cookie.

**In crease** (applied in our copies, documented with a patch in [crease-changes.md](crease-changes.md)):
- `attributes` on `input`/`textarea`;
- `activateOnHover` on `dropdownMenu`;
- a recommendation that keyboard navigation not render items.

**The clone afterwards:**
- **Keyboard:** its keyboard island is gone, with all shortcuts on `keyBindings`.
- **Focus:** lands with the morph (15 ms after a click instead of 32 ms).
- **Check:** grew to 43 steps and passes in both modes.

**Measured at 80 ms round-trip time:** every interaction costs the round trip plus about 20 ms: a status change 102 ms, opening a picker 99 ms, `j`/`k` 103 ms. Fine for changes to data; too slow for screen-only interactions, which are instant in Linear.

**The proposal** [design-latency.md](design-latency.md) awaits a decision:
- popover menus without a round trip;
- forwarded Commands that report back, so crease's modal dialogs work;
- navigation within a session, which changes `layer`, so decide before the freeze;
- local selection effects;
- later, optimistic hints.

### Phase B: deployable (2026-10-26)

Deployment guidance from these results is in [deployment.md](deployment.md); the measurements in [performance.md](performance.md).

#### B4: experiment 4, network reality

**Proxies.** nginx in Docker in front of Dispatch (`tools/net/nginx.conf`, `nginx.sh`), plain HTTP/1.1 and TLS with HTTP/2.
- **Found:** with nginx's default response buffering, live updates never arrived; `check:dispatch` timed out waiting for the first morph.
- **Fixed in core:** event streams send `X-Accel-Buffering: no`, which nginx honours per response. No proxy setting is needed.
- `check:dispatch` passes 24/24 over HTTP/1.1 and over HTTP/2 (the browser negotiated `h2`).
- Caddy and HTTP/3 are not tested (not installed here).

**Bad networks.** `tools/net/shaper.mjs` is a TCP proxy with latency and jitter, retransmission-like stalls, and connection resets at random times.
- With 150 ± 100 ms, 5% stalls of 600 ms and half of all connections reset:
  - `check:dispatch` passed 24/24 twice (4–5 resets, 12–14 stalls per run);
  - `check:admin` 24/24 (7 resets);
  - `check:inputs` 6/6.
- Resets hit streams (Datastar reconnects) and event posts (Datastar retries, and the sequence number deduplicates).
- The first version of the shaper reordered TCP data under jitter (timers with different delays fire out of order), which broke the map island's script. That was the tool, not the app; it now releases chunks from one queue per direction.

**Input.** `check:inputs`, new, against a page morphing four times a second from another dispatcher's changes:
- **IME composition** through Chrome DevTools: the composition is never overwritten, and the committed text reaches the server.
- **Autofill:** a value set by script with input and change events and submitted in the same task arrives with the submit.
- **A change event alone** (some password managers): the value was lost. The page script now announces such a value as an input event, and it arrives.
- Safari and mobile browsers are not tested: WebKit is not installed here.

**Compression.** `Options.compression`, off by default. One gzip compressor per stream, flushed after every patch:
- 30× fewer bytes on the wire (1,040 → 35 kB/s at 200 pages); a 5.9 kB region patch travels as about 160 bytes.
- About 155 kB more memory per open page.
- Under a 200-page fan-out, p50 +43 ms and p95 +27 ms: each stream waits for zlib's thread pool, and those callbacks run after the fan-out's renders. With one stream there is no delay.
- Brotli compresses 2–3× better still, but keeps 360–600 kB per stream; gzip with a 16 kB window keeps 165 kB.
- Worth it on the internet (a 6 kB patch is 24 ms at 2 Mbit/s), not on a LAN.

#### B5: real persistence

- **`Hyper.sqlStore()`** keeps snapshots in any SQL database through Effect's `SqlClient`, with no new dependency in core.
  - Writes are one upsert (atomic). Rows expire `ttl` after their last write and are never read after; a purge deletes them, which removes the snapshots of sessions whose process died.
  - `sql-store.test.ts` runs against Postgres when `HYPER_TEST_DATABASE_URL` is set: values, expiry and purge, and a session carried from one process to another.
  - `tools/postgres/start.sh` (`npm run db:start`) runs a throwaway Postgres in Docker.
- **The admin on Postgres** (`DATABASE_URL`): products, images and snapshots (`examples/admin/src/app/catalog/postgres.ts`), the reference for app state across processes.
  - Every write runs in a transaction with `pg_notify`; each process listens once and turns notifications into the version its lists watch.
  - Edit conflicts are a conditional `UPDATE` on the revision; a taken SKU is the unique constraint.
  - `check:admin` passes 24/24 on Postgres.
- **`check:admin-nodes`**, new: two admin processes on one Postgres, 10/10:
  - a save on one shows live in a list on the other;
  - an image uploaded on one is served by the other;
  - a stale save is refused across processes, and so is a taken SKU;
  - behind a sticky balancer, the process holding an editor's session is killed mid-edit, and the page continues on the other process from the snapshot in Postgres and saves.
- **Found on the way:** the test balancer answered 502 for a post to a dead upstream, which Datastar does not retry. It now resets the connection and skips dead upstreams for a few seconds, as Dispatch's router does.
- **Durable events on Postgres** (200 pages, 200 events/s): answer p50 72 ms, against 147 ms on files and 28 ms in memory, at 9 points more Node CPU than memory (Postgres in Docker Desktop on Windows; its own CPU not counted).
- Redis is not tested (no image here).

#### B6: load and soak

**The admin under load** (200 lists, one save a second; every list re-queries on every change):
- **Found:** every change rendered every list twice. The change Message only starts the query, but core rendered after every Message.
  - **Fixed in core:** a Message that leaves the Model unchanged publishes nothing. The exceptions are an applied typed value (the input may need patching back) and a forwarded browser action waiting for a render.
  - Commands now run before the Model is published, so a forwarded action goes out with that render.
- **Found:** the admin created an `Intl.NumberFormat` per price (7% of busy time); it is now made once.
- Results, medians of 3 interleaved rounds:

  | Store, queries | p50 before → after | p95 before → after |
  |---|---|---|
  | memory, all the same | 313 → 213 ms | 496 → 366 ms |
  | memory, varied | 274 → 149 ms | 416 → 255 ms |
  | Postgres, all the same | 355 → 291 ms | 606 → 517 ms |
  | Postgres, varied | 317 → 230 ms | 488 → 419 ms |

- Each list still waits for its own query (a Command between change and render), and on Postgres for the connection pool: 200 lists are 400 queries per change.
- The next lever is the app's: lists showing the same query could share its result, as Dispatch shares its store.

**Concurrent uploads** (20 editors uploading 2 MB at once, 3 rounds; `scripts/upload-load.mjs`):

| Store | Answer p50 | p95 | RSS idle → peak → after |
|---|---|---|---|
| memory | 184 ms | 199 ms | 193 → 297 → 365 MB (the 120 MB of images stay in memory) |
| Postgres | 196 ms | 298 ms | 190 → 240 → 241 MB |

- No failures. Oversized uploads (4 MB, limit 3 MB) are refused with 413 from their Content-Length (p50 about 110 ms, the time to send the request).
- A burst of 40 MB of uploads peaks at about 50–100 MB above idle: the multipart parts plus the `File` objects.

**Soak** (`tools/perf/soak.mjs`): Dispatch for two hours with 200 live pages, 20 of them replaced every minute (about 2,300 sessions opened and closed), one shared change a second and 40 page events a second. Samples every 30 s, after a forced GC:
- **No leak:** the heap stayed between 120 and 126 MB (trend +0.1 MB per hour after a 10-minute warm-up). RSS moved between 315 and 723 MB with the allocator, without a trend.
- **Everything retained stays bounded:**
  - about 80 handler tables per session (the live ones plus at most 64 replaced);
  - 15 regions per session;
  - 8 shared-region cache keys;
  - snapshot files tracking the live sessions, since closed sessions delete theirs.
- **No failures:** no stream dropped and no event refused. Render time stayed at 0.49–0.54 ms.
- The session-ending run stopped the script at minute 118 of 120, before its summary; the samples are in `output/soak.jsonl`.

**Phase B is done, except for what this machine cannot test:** Safari and mobile browsers, Caddy and HTTP/3, Redis, and server hardware. Phase C (0.1) is next.

### Phase A: lossless failover and the region review (2026-10-26)

**Performance is closed for now.** Experiment 7 brought p95 to 69 ms at 200 pages (2 workers) and 220 ms at 1000 pages (3 workers) on this laptop, which is good enough to go on with. The run on server hardware waits for a machine; the open levers stay in [performance.md](performance.md#levers-not-yet-tried).

#### A2: delivery across failover

**The rule:** an event is answered (204) only once it is applied **and** a snapshot written after that has completed (`Options.durableEvents`, on by default).
- **Shared writes:** snapshot writes of a session run one at a time, and every request made while one runs is covered by the next. So 20 events arriving together took at most 5 writes in the test.
- **Answers:** an event waiting behind a gap is answered when the gap closes; a repeat is answered with its original.
- **The old rule** is still there as `durableEvents: false`: answered once applied, snapshot a quiet second later.

**Why it is lossless:**
- Datastar retries a request that fails at the network level (after 1 s, doubling, at most 10 times), with the same body and sequence number. It takes an error status as final.
- So every event a page was told about is in the snapshot. Every other one is retried, and the process taking over restores the snapshot and either applies it (it is not in the snapshot) or drops it as a repeat (it is).

**Holes found on the way.** Each had a failing test or check first:
1. **Model and position could disagree.** The position advanced when an event was received, the Model when the update loop applied it. A snapshot in between counted an event as done whose effect it lacked.
   - Now the update loop changes the Model, the position and the skipped numbers together, per event (`Session.applied()`).
   - Queue items are whole events: an event's unsent input values and the event itself apply in one step.
2. **Skipped numbers were not in the snapshot.**
   - The sequence: an event is lost on its way; the event after it waits; the gap is skipped and the later event applied; the process fails.
   - The retry of the lost event reaches the next process, which knows only the position and takes it for a repeat: answered, never applied.
   - Snapshots now keep the skipped numbers (`skipped`), and a restored intake starts with them.
   - The protocol simulation's random search finds this hole when it is put back, and so does an HTTP test.
3. **Truncated snapshots.**
   - Effect's `KeyValueStore.layerFileSystem` writes in place, so a process killed mid-write left a snapshot that no restore could read, and the next process started the page over.
   - Durable events write on every event, so `check:cluster` hit it.
   - **`Hyper.fileStore(directory)`** writes a temporary file and renames it over the old one. Dispatch and the admin use it. Any store used across machines must write atomically too.
4. **The router could move a session twice.** A dead worker's sessions were hashed over the live workers. When the replacement started, a session could move to another worker while the first survivor still held its stream. Now each dead worker gets one heir, kept while it lives, and the heir of a dead heir takes over both.
5. **The router answered 502 for a worker that died mid-request.** Datastar does not retry error statuses, so the event was lost. Session requests now get their connection reset. A proxy in front of hyper-effect must do the same, or retry on another upstream.

**Tests:**
- `failover.test.ts`, six tests with two processes sharing a store:
  - an answered event is in the store at once;
  - a retry is dropped on the next process;
  - an event behind a gap is answered once the gap closes;
  - a skipped event's late retry is applied after failover;
  - concurrent events share writes;
  - without durable events, an answered event is lost.
- **`failover-protocol.test.ts`** models the whole protocol over the real intake:
  - Datastar's retries, lost requests and lost answers, write latency, and up to three process failures at random times;
  - 2000 generated scenarios per property: no event applied twice, no answered event lost, every event answered in the end;
  - two fixed counterexamples document the old rule and the snapshot without skipped numbers.
- `file-store.test.ts`: whole-file replacement, concurrent writers, and a partial temporary file.
- **`check:cluster`, 21 checks.** A click answered right before its worker is killed survives. A click in flight while the heir is killed is retried and applied on the next heir. The session stays with its heir when the replacement worker starts.
  - With `DISPATCH_AB_DURABLE=0`, the answered click is lost (20/21), so the check tells the two rules apart.

**Cost.** 200 pages, each clicking its own selection once a second (200 events/s, each a snapshot write), plus the usual 1 change/s fan-out. Medians of 3 interleaved rounds (`EVENTS=1`, see [performance.md](performance.md#durable-events)):

| Snapshot store | Rule | CPU | Answer p50 | Answer p95 |
|---|---|---|---|---|
| Files (`fileStore`, Windows) | durable | 119% | 39 ms | 273 ms |
| Files (`fileStore`, Windows) | debounced | 76% | 16 ms | 87 ms |
| Memory | durable | 54% | 16 ms | 105 ms |
| Memory | debounced | 51% | 11 ms | 80 ms |

- **The write is the cost, not the snapshot.** Encoding and sealing a whole board snapshot (6.5 kB) takes 0.04 ms. A snapshot of the session's own state only would save under 1% of a core at this rate, so the snapshot API stays as it is.
- The file store on Windows (open, write, rename on the I/O threads, plus the virus scanner) is slow. Phase B5 measures Redis and Postgres.
- The sealer now creates its key objects once (they were made per seal).

**Limits:**
- **Commands in flight die with their process.** An HTTP call or a store write started by an answered event is not rerun by the next process. Make such effects idempotent, or record the intent in the Model and act on it after a restore.
- **A failed store write** is logged and the event is still answered: it was applied, and only a failure of this process would lose it.
- Messages from Subscriptions and Commands are still snapshotted a quiet second later, or with the next event.

#### A3: region API review

1. **Sharing across sessions stays explicit (`shared: true`).**
   - Automatic sharing for regions that bind only Messages is rejected. A region's deps check runs within one session, so it cannot see data that is constant per session, such as the user's name. Shared automatically, that data would reach other users.
   - **New:** outside production, every render of a shared region is compared with the markup rendered for the same deps before, in any session. A difference fails the render, naming the region (`shared-region.test.ts`: a greeting that reads the user fails for the second user).
2. **Deps outside `view` (skipping the frame render): not for 0.1.**
   - A page update costs about 0.2 ms of rendering in all; skipping the view would save part of that.
   - The price is a second description of the view's inputs, which must be kept in step with the view, as region deps must be.
   - It would be an additive option (for example `Program.viewDeps`), so it does not need deciding before the API freezes. Revisit if a profile shows the frame render dominating.
3. **`region(h, { id, deps, render, shared })` stays as it is.**

**Phase A is complete. Phase B (deployable) is next:** experiment 4 (network reality), real persistence, and more load and soak tests.

### Experiment 7: multiple cores and cheaper updates (2026-10-26)

All numbers: Dispatch board, production mode, 1 change/s, presence every 2 s, on the laptop described in [performance.md](performance.md). They are medians of interleaved runs (`tools/perf/matrix.mjs`), because single runs on this machine vary by up to 2×.

**Routing per session:**
- `Options.node` names a process; its session ids become `<node>.<uuid>`, and `nodeOfPath(path)` reads the node back.
- `examples/dispatch/src/cluster.ts` runs a primary with a router and one worker per core (`npm run start:cluster`, `WORKERS=n`). The router:
  - sends a session's stream and events to the worker its id names, and page loads and assets round-robin;
  - moves a dead worker's sessions to one survivor per session (by hash), which restores them from the shared snapshot store; the replacement worker gets a new name;
  - sums all processes' metrics, its own included.
- **App state across processes:** Dispatch's store and presence live in the primary. Workers forward writes over IPC and get every new state broadcast (`cluster-store.ts`), standing in for a database plus change feed.
- **Checks:** `check:dispatch` passes 24/24 through the router with 2 workers, in development and production. `check:cluster` has a third scenario: kill the worker that holds the session, and the page continues on a survivor with selection and draft; 16/16 checks pass.

**Cores on this laptop** (Core Ultra 7 258V: 4 performance and 4 efficiency cores, power-limited):

| 200 pages | p95 | CPU time per page update |
|---|---|---|
| 1 process | 242 ms | 1.5 ms |
| 2 workers | 179 ms | 2.1 ms |
| 3 workers | 149 ms | 2.9 ms |
| 4 workers | 177 ms | 3.5 ms |

(Before the per-update levers below; a quiet round.)
- More busy cores make every update cost more CPU time: the clock drops under the power limit, and the efficiency cores are slower. So scaling stops at 2–3 workers here.
- The router costs nothing measurable: sending streams directly to the workers (`DIRECT=1`) measured the same.
- The load generator stays under 10% of a core.
- **Server hardware with real cores is the open measurement.**

**Cheaper updates.** These matter on any machine; A/B, interleaved:

| Lever | Effect |
|---|---|
| No stack capture while views render in production (Foldkit's `captureCallSite`) | render −14%, CPU −18% |
| `memoizeLast` for Messages of shared feeds | not measurable at Dispatch's size; kept for larger payloads |
| `Program.snapshotDeps`: snapshot only the session's own state (and its intake position) | CPU −7% |
| `region({ shared: true })`: rows and the activity feed render once per change for all sessions | render −10% |
| All four together | p95 268 → 193 ms, render 0.90 → 0.70 ms, CPU −27% |
| The incident list split into three regions, so the filter widget (whose key handlers are probed on every render) is kept unless the filter changes | busy time halved: p95 165 → 88 ms in a profile run |
| Subscriptions and the snapshot trigger checked in the update loop, instead of a stream per session watching every Model change | busy time −24% at 1000 pages |
| Unchanged region markup compared as plain strings first; the region id check only in development | busy time −5% |

**Where it ends up:**

| | 200 pages p95 | 1000 pages p95 |
|---|---|---|
| Start of the day, 1 process | 263–330 ms | 1,318 ms |
| All levers, 1 process | 96 ms | 358 ms |
| All levers, 2 workers | **69 ms** (p50 43 ms) | 257 ms |
| All levers, 3 workers | (power-limited, see above) | **220 ms** |

- A page update now costs about 0.2 ms of rendering.
- The target (p95 under 50 ms at 200 pages) is reached for p50 but not p95 on this laptop.

**Tests:**
- Node ids and failover restore (`node.test.ts`), shared regions (`shared-region.test.ts`), snapshot deps (`snapshot-deps.test.ts`), and Subscription restarts (`subscriptions.test.ts`).
- 110 vitest tests in all.
- Browser checks: dispatch 24/24 (single process in development; 2 workers in production), restart 4/4, admin 24/24, cluster 16/16.

**Next for performance** (details in [performance.md](performance.md#levers-not-yet-tried)):
- the run on server hardware;
- a leaner per-connection pipeline;
- dropping Foldkit's `renderToString` frame for views without Submodels (its validation stub still costs about 3% in parse5);
- compression (experiment 4).

### Experiment 5: correctness proof (2026-10-26)

**Ordered intake, as a pure module** (`packages/core/src/intake.ts`):
- The intake is a state machine (`receive`, `expire`, `deadline`, `isRepeat`) that the session drives with one timer for its deadline.
- **Properties** (`packages/core/test/intake.test.ts`), checked with Effect's `it.prop` over generated networks (`test/intake-simulation.ts`). Each event gets a send gap, a network delay of up to 3 s, and a fate: lost (10%), sent twice (10%) or delivered once:
  1. every event that arrived is applied exactly once;
  2. events applied in order are in ascending order;
  3. an event is applied out of order only after a later one went ahead (its gap was skipped);
  4. nothing is held forever;
  5. a parked event waits at most one gap timeout per earlier lost event;
  6. on a good network (no loss, delays under half the timeout), everything is applied in exact order.

**The same properties against a faithful port of the previous algorithm found two bugs,** with shrunk counterexamples:
- **Applied twice:** an event sent twice was applied twice. The counterexample is one event, sent twice. A late copy below the next expected number was treated as "late, but still the user's input". In Dispatch that is a double "Take it" or a doubled comment, wherever a request is retried after its answer was lost.
- **Held forever:** events 1 and 3 lost, 2 and 4 arrive. After the first gap was skipped, no timer was armed for the second, and event 4 waited until some unrelated event arrived.

**Fixes:**
- **Repeats** are recognised: a number below `next` is applied only if it was skipped (once), otherwise dropped. A number already parked is dropped too. A dropped repeat touches nothing, not even the record of typed values in flight.
- **Every new gap gets its own deadline.** Its clock starts when the previous gap closed.
- **Bounds:** at most 64 parked events (more skip the gap at once), and at most 256 skipped numbers remembered, even for a huge jump in `q`.
- **Atomic batches:** a step's events reach the update loop in one batch, so concurrent posts cannot interleave.
- **Position in snapshots:** snapshots now store the intake position, so a restored session continues exactly where the snapshot was taken. A retried event is dropped, a new one applied. Without the position, a restore would have applied the retry again; `test/delivery.test.ts` fails with count 4 instead of 3 when the position is ignored.
- **Sessions recreated from their URL** (no snapshot) learn their position from the first event and accept the 32 numbers before it once.

**Two nodes, one shared store** (`tools/cluster`: a load balancer, sticky by cookie or round-robin, and `npm run check:cluster`, which starts two Dispatch processes on one `.hyper-sessions` directory and drives Chromium through the balancer):

| Mode | Result |
|---|---|
| Round-robin | Broken, as expected. The page loads on node A, its stream lands on node B, which recreates the session from the URL (no snapshot yet), and events alternate between the two copies. 3 of 6 clicks showed on the page. |
| Sticky by cookie | Works, failover included. 8/8 checks: clicks; then the browser's node is killed; the page reconnects through the balancer; the browser is re-pinned to the other node, which restores the selection and the half-typed draft from the shared store; the session keeps working; no page errors. |

**Conclusions:**
- **Stickiness is required.** Two nodes must never serve one session. Routing per session (a node hint in the endpoint) would be better than per browser; that is phase A of the plan.
- **App state across nodes is the app's job.** Each Dispatch node still has its own in-memory incident store, so the experiment only shows session continuity. A database plus a change feed is the answer (phase B).
- **Failover is exactly-once from the snapshot, not lossless.** Events applied in the dead node's last second before its snapshot are lost (phase A, step 2).
- **A finding in the admin, surfaced by the faster intake:**
  - **The problem:** the pager and the sort arrows showed the requested page while the table still showed the previous one, for one render.
  - **The fix:** they now show the query of the page on screen (`shownQuery`), and the admin check waits for the data, not the URL.

**Tests:**
- 103 vitest tests: 10 intake tests (4 properties, 6 cases) and 2 delivery tests over HTTP.
- `check:cluster`: 9/9 checks pass. One of them asserts the expected round-robin failure.
- All other browser checks pass: dispatch 24/24, restart 4/4, admin 24/24 on three fresh servers and at 300 ms latency.
- **Performance:** an A/B run (old against new intake, same conditions) shows no difference. Both measured 1.9 ms per render on a busier machine that day (see [performance.md](performance.md)).

### Decisions after experiments 1–3

- **Extraction can start.** None of the three results changes the architecture. Experiment 1 adds region patches and multi-core to the plan rather than invalidating anything.
- **Before 0.1:** upload support; the Foldkit upstream asks (serializer, `captureCallSite`, Dom service). Region patches, auth in Flags and CSP with a nonce are done (see the results above).
