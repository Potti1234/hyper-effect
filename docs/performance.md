# Performance: what has been measured, how, and what is left

This is the working notebook for hyper-effect's server performance: the method, every result so far, where the time goes now, and the levers not yet tried. The roadmap ([roadmap.md](roadmap.md)) records the decisions; this file is for picking the work up again.

**State (2026-10-26, after phase B):**
- **200 pages:** one change on the Dispatch board reaches all of them with p95 ≈ 95 ms on one process, ≈ 70 ms (p50 ≈ 43 ms) on 2 workers.
- **1000 pages:** p95 ≈ 360 ms on one process, ≈ 220 ms on 3 workers; no updates lost.
- **A page update costs about 0.2 ms of rendering,** down from 2–3 ms after experiment 1.
- **The target** (p95 under 50 ms at 200 pages, 1 change/s) is reached for p50 but not p95 on this laptop. More cores stop helping at 2–3 workers here, because the CPU is power-limited (see [Multiple cores](#multiple-cores)). Server hardware is the open measurement.

## How to measure

```sh
npm run perf:load -- 200 1 15      # sessions, changes per second, seconds
WORKERS=3 npm run perf:load -- 1000 1 15    # the same against src/cluster.ts with 3 workers
npm run perf:profile -- 200        # the same load plus a 6 s CPU profile and its summary
node tools/perf/matrix.mjs 3 200 10 "1proc=" "2w=WORKERS=2" "no-stacks=HYPER_VIEW_STACKS=1"
                                   # configurations interleaved over 3 rounds, medians
npm run load-test -- --sessions 50 --rate 2 --duration 20   # against a server you started yourself
EVENTS=1 npm run perf:load -- 200 1 10           # every page also posts its own events (answer latency)
DISPATCH_AB_COMPRESSION=1 ENCODING=gzip RAW=1 npm run perf:load -- 200 1 10   # compressed streams, timed raw
bash tools/perf/admin-load.sh 200 1 10           # the catalog admin (VARIED=1, PG=1)
node examples/admin/scripts/upload-load.mjs --uploads 20 --megabytes 2   # against a running admin with HYPER_METRICS=1
node tools/perf/soak.mjs 120 200 20 0.2 1        # minutes, pages, churn per minute, events per page per s, changes per s
```

### `tools/perf/matrix.mjs`
- Runs `load.sh` for each configuration (`label=ENV=value,ENV=value`) in turn, for several rounds, and prints the median of every figure.
- Each run is also appended to `output/perf-matrix.jsonl`.
- **Use it for every comparison:** slow phases of the machine then hit every configuration alike.
- **A/B switches:** `examples/dispatch/src/app/dispatch/levers.ts` lists the switches for the example's levers, and `HYPER_VIEW_STACKS=1` is core's switch for stack capture.

### `tools/perf/load.sh`
1. Starts the Dispatch server with `NODE_ENV=production`, `HYPER_METRICS=1`, `--expose-gc`, presence sampled every 2 s (`PRESENCE=<s>` to change) and an empty snapshot store.
   - With `WORKERS=n`, it starts `src/cluster.ts` instead, and waits until all workers report.
   - With `DIRECT=1`, the load test sends each session's requests straight to its worker, bypassing the router.
2. Runs the load test.
3. Stops the server. Server output goes to `output/load-server.log`.

### `examples/dispatch/scripts/load-test.mjs`
- **Pages:** each simulated page signs in (`POST /login`), loads the board (page GET) and opens its SSE stream, exactly as a browser does.
- **Driver:** a separate page posts `ClickedTakeIncident` / `ClickedReopenIncident` for `INC-101` at the given rate. Every change touches the incident list, one row, the map props and the activity feed on every page.
- **Latency:** for each listener and each change, the time from sending the driver's POST to the first patch that arrives on that stream afterwards. A change with no patch before the next change (+1.5 s) counts as **missed**.
- **Page events** (`--events n`, or `EVENTS=n` for `load.sh`, `matrix.mjs` and `profile.sh`): every page also clicks its own selection n times a second, and the time until each click is answered is reported. With durable events an answer includes the snapshot write. Own clicks add patches, so the fan-out latency is then only indicative.
- **The generator's own CPU** is reported. It has stayed under 10% of a core, so it does not limit the measurement.
- **Server figures** come from `GET /_hyper/metrics` before and after the drive phase. Behind the router, they are the sum over all processes:

| Figure | Meaning |
|---|---|
| renders | Session renders during the drive. |
| render mean / p95 | Time inside `renderModel` plus region bookkeeping, in ms. |
| CPU | Process CPU time ÷ wall time, so above 100% means GC or I/O threads helped. |
| patch kB/s | Uncompressed SSE bytes written. |
| regions kept / unchanged / new | Kept: deps unchanged, not rendered. Unchanged: rendered, identical markup, not sent. New: rendered and sent. |
| memory per session | RSS and heap growth after connecting, divided by pages. Needs `--expose-gc` to be meaningful. |

`tools/perf/profile.sh` runs a 25 s load, captures 6 s of CPU profile in the middle (`POST /_hyper/metrics/profile?seconds=6`), writes `output/server.cpuprofile` (open it in Chrome DevTools, Performance tab) and prints `tools/perf/profile-summary.mjs`: self time by package and by function, idle excluded.

### Machine
- Intel Core Ultra 7 258V (8 threads), 32 GB, Windows 11.
- Node 26.4; some earlier runs used Node 24.11.
- Everything runs locally, load generator included. The generator shares the machine, so absolute numbers are pessimistic.
- Runs vary by about ±10% back to back, and by up to 2× across days: on 2026-10-26, with other software busy, the same build measured 1.9–2.0 ms per render instead of 1.0 ms.
- **Compare code changes A/B, interleaved** (`tools/perf/matrix.mjs`); never compare against a number from another day. Check the background load first, for example `(Get-CimInstance Win32_Processor).LoadPercentage`.
- **A power-limited, hybrid CPU:** the Core Ultra 7 258V has 4 performance and 4 efficiency cores, and a 17 W budget. With more cores busy, each update takes more CPU time: 1.5 ms per update with one process, 3.5 ms with four workers, for the same work. Multi-core numbers from this machine understate what server hardware would do.

### Pitfalls
- **Development mode is 3–10× slower.** Outside production, every render goes through Foldkit's validating `renderToString` (a parse5 re-parse), and every kept region is rendered a second time by the deps check. Always measure with `NODE_ENV=production`.
- **Page limits:** `HYPER_METRICS=1` raises the per-address page limit in `examples/dispatch/src/main.ts`. Without it, a load test from one address gets 429s after 50 pages.
- **Leftover servers on Windows:** a server started through `npx tsx` leaves a child process holding the port when the wrapper is killed. The perf scripts start `node --import tsx` directly and kill that PID. If a port stays busy: `Get-NetTCPConnection -LocalPort 3000 -State Listen`.
- **Presence:** every presence change re-renders every page. Measure with presence sampled (the default 2 s) unless presence itself is the subject.
- **Snapshots** are sealed (AES-GCM) in the example. Writing them for every session after every shared change cost about 7% of CPU; `snapshotDeps` limits them to the session's own state. With durable events (the default), every event writes one as well. `.hyper-sessions` must be empty at the start, which the scripts ensure.
- **Workers on Windows:** with `node:cluster`, the primary owns the workers' listening sockets. To kill one worker, kill its PID (the router lists them at `/_hyper/cluster`), not "whatever listens on its port", which is the primary.

## Results history

All rows: the Dispatch board, one core, production mode, 1 change/s and presence every 2 s unless noted. p50 / p95 is the update latency over all pages.

| Date | State | Pages | p50 / p95 | Render mean | CPU | Patch bytes | Notes |
|---|---|---|---|---|---|---|---|
| 2026-10-23 | Baseline: one validated render, no load | — | — | 31 ms (7 incidents), 117 ms (100) | — | 37 kB per morph (7) | ~45% of render time in parse5 |
| 2026-10-23 | Experiment 1, all its levers | 50 | 123–140 / 240–260 ms | — | 26% | — | |
| | | 200 | 366 / 751 ms | ~2–3 ms | 71% | — | 0 missed |
| | | 1000 (0.5/s, presence 30 s) | 1,638 / 3,247 ms | 2.8 ms | 120% | 10.3 MB/s | 955 merged by conflation |
| 2026-10-23 | After the security hardening (sign-in, CSP, sealed snapshots) | 200 | 345 / 615 ms | 2.1 ms | 64% | 7.5 MB/s | no measurable cost |
| 2026-10-23 | Flat regions | 200 | 213 / 447 ms | 1.4 ms | 51% | 5.0 MB/s, 29 kB per patch | 34% of regions kept |
| 2026-10-23 | Nested regions (row per region), deps by reference | 200 | 178 / 340 ms | 1.2 ms | 39% | 1.1 MB/s, 6.4 kB | rows re-rendered: Messages copy data |
| | | 1000 | 722 / 1,470 ms | 1.1 ms | 138% | 4.0 MB/s | |
| 2026-10-23 | Deps by value (`Equal.equals`) | 200 | 166 / 316 ms | 1.1 ms | 36% | 1.1 MB/s | 3 of 7 regions kept per render |
| 2026-10-23 | Deps by value, direct walk (current) | 200 | 140 / 330 ms | 0.93 ms | 31% | 1.1 MB/s | |
| | | 1000 | 651 / 1,318 ms | 0.88 ms | 139% | 4.6 MB/s | saturated, 0 missed |
| 2026-10-23 | Re-run with `tools/perf/load.sh` (10 s) | 200 | 160 / 280 ms | 0.99 ms | 35% | 1.0 MB/s | run-to-run variance |
| 2026-10-26 | Experiment 5's intake, on a busier machine (background load 25–28%) | 200 | 300–325 / 575–585 ms | 1.9–2.0 ms | 59–63% | 1.0 MB/s | A/B with the old intake in the same conditions: identical (1.9 ms). The machine, not the code, was slower. |
| 2026-10-26 | Workers before the levers below (a quiet round), 2 / 3 / 4 workers | 200 | p95 179 / 149 / 177 ms | 1.2–1.9 ms | | | 1 process: 242 ms. Scaling stops at 3 workers (power limit). |
| 2026-10-26 | Stack capture off, shared Messages, snapshot deps, shared regions (medians) | 200 | 111 / 193 ms | 0.70 ms | 24% | 1.0 MB/s | the same build with the levers off: 149 / 268 ms, 0.90 ms, 33% |
| 2026-10-26 | Incident list split into three regions; Subscription and snapshot checks in the update loop; cheaper markup comparison (medians) | 200 | 58 / 96 ms | 0.22 ms | 17% | 1.0 MB/s | levers off, structural changes on: 85 / 183 ms |
| | | 1000 | 208 / 358 ms | 0.18 ms | 63% | | |
| 2026-10-26 | The same on 2 workers (medians) | 200 | **43 / 69 ms** | 0.31 ms | 26% | | |
| | | 1000 | 136 / 257 ms | 0.26 ms | 83% | | |
| 2026-10-26 | The same on 3 workers (medians) | 1000 | 115 / **220 ms** | 0.32 ms | 84% | | |

**Memory:** the heap grows by about 250–300 kB per session (1000 sessions: ~260 MB), and RSS by 370–530 kB per session.

**Per page update now:**
- **Kept:** header, filter and search, count, selection panel, report form.
- **Rendered to identical markup:** the list of rows around the changed one.
- **Rendered new:**
  - the changed row and the activity feed: shared, so rendered once for all sessions and reused;
  - the map's props.
- The frame never changes, so every patch is region-only. The average patch is 6.4 kB uncompressed.

## Multiple cores

**Setup** (`examples/dispatch/src/cluster.ts`):
- A primary process runs a router and the shared store; N workers each run the full app.
- Session ids carry their worker's name (`Options.node`), and the router (`src/cluster/router.ts`, Node `http` with keep-alive to the workers) sends a session's stream and events there. Page loads go round-robin.
- Store writes go to the primary over IPC, and new states are broadcast to all workers.

**Findings:**
- **Functionally sound:**
  - `check:dispatch` passes through the router, including live updates and presence across workers;
  - a killed worker's sessions continue on one heir, without losing an answered event (`check:cluster`).
- **On this laptop, 2–3 workers are the sweet spot.**
  - 200 pages: 1 → 2 workers cuts p95 by about 30%, and 3 workers is no better.
  - 1000 pages: 3 workers cut p95 from 358 to 220 ms.
  - The cause is the power-limited hybrid CPU: CPU time per update rises with every busy core.
- **The router is not a bottleneck.** Bypassing it (`DIRECT=1`) measured the same, within noise.
- **Not measured:** server hardware. On a machine with steady clocks, the expectation is close to linear until the router's one thread or the broadcast becomes the limit; measure that first when such a machine is available.

## Durable events

Since phase A2, an event is answered only once its snapshot is written (`durableEvents`; the roadmap has [the design](roadmap.md#a2-delivery-across-failover)). To measure the cost, every page also posts events (`EVENTS=1`: 200 pages, 200 events/s, each a snapshot write, plus 1 change/s fan-out), with `DISPATCH_AB_DURABLE=0` as the old rule:

```sh
node tools/perf/matrix.mjs 3 200 10 durable=EVENTS=1 debounced=EVENTS=1,DISPATCH_AB_DURABLE=0
node tools/perf/matrix.mjs 3 200 10 durable-memory=EVENTS=1,DISPATCH_AB_SNAPSHOTS=memory debounced-memory=EVENTS=1,DISPATCH_AB_DURABLE=0,DISPATCH_AB_SNAPSHOTS=memory
```

| Store | Rule | Fan-out p95 | CPU | Answer p50 | Answer p95 |
|---|---|---|---|---|---|
| `fileStore` | durable | 215 ms | 119% | 39 ms | 273 ms |
| `fileStore` | debounced | 179 ms | 76% | 16 ms | 87 ms |
| memory | durable | 183 ms | 54% | 16 ms | 105 ms |
| memory | debounced | 192 ms | 51% | 11 ms | 80 ms |

- **The store's write is the cost.** In memory, durable events cost about 3 points of CPU and 5 ms at the median.
  - The file store on Windows costs much more: open, write and rename on libuv's I/O threads, with the virus scanner looking at every new file.
- **Encoding and sealing are cheap:** a whole board snapshot (6.5 kB) takes 0.026 ms to encode and 0.014 ms to seal. Own state only (0.4 kB) would save under 1% of a core at 200 events/s.
- **A profile** of the durable file-store run shows Schema encoding at about 5% and key handling in `node:crypto` at about 3% of busy time. The sealer now creates its key objects once.
- The first matrix ran while the race fix and the shared-region check went in. Neither touches the event path's cost, but repeat it before quoting the file-store numbers precisely.
- **Postgres** (phase B5, `DISPATCH_AB_SNAPSHOTS=postgres`, `sqlStore` on `postgres:17-alpine` in Docker on this laptop), same load, medians of 3 interleaved rounds:

  | Store | Fan-out p95 | Node CPU | Answer p50 | Answer p95 |
  |---|---|---|---|---|
  | `fileStore` | 347 ms | 133% | 147 ms | 559 ms |
  | `sqlStore` (Postgres) | 298 ms | 94% | 72 ms | 517 ms |
  | memory | 286 ms | 85% | 28 ms | 224 ms |

  - Postgres halves the file store's median answer and costs the Node process about 9 points of CPU more than memory; Postgres's own CPU runs in Docker's VM and is not counted.
  - The tail (p95 517 ms) includes Docker Desktop's networking on Windows; a database on a server network should do better.
  - These runs had the soak test running alongside (one more core busy), so compare within the table only.
- **Not measured:** Redis, and Linux file systems.

## Compression

`Options.compression` (experiment 4): one gzip compressor per stream, flushed after every patch, so each patch is encoded against the earlier ones. Measured with `RAW=1`, which times the compressed bytes as they arrive rather than the load generator's decoder:

```sh
node tools/perf/matrix.mjs 3 200 10 none=ENCODING=gzip,RAW=1 gzip=DISPATCH_AB_COMPRESSION=1,ENCODING=gzip,RAW=1
```

| | Fan-out p50 | p95 | CPU | Patches | On the wire | RSS per page |
|---|---|---|---|---|---|---|
| none | 137 ms | 257 ms | 26% | 1,041 kB/s | (same) | 417 kB |
| gzip | 180 ms | 284 ms | 24% | 1,040 kB/s | 35 kB/s | 571 kB |

- **30× fewer bytes.** The first patch (the whole page, 40 kB) compresses about 8× (5.2 kB), later region patches 36× (5.9 kB on average → 164 B).
- **Memory:** about 155 kB more per open page, the compressor's state.
- **CPU:** no difference measurable. Compressing one patch for 200 streams takes 2–3 ms on zlib's thread pool.
- **Latency:** with one stream there is none (1.5 ms either way). Under a 200-page fan-out, p50 rises 43 ms and p95 27 ms: every stream waits for its zlib callback, and those run only after the fan-out's renders, so patches leave together at the end instead of one by one. Node's zlib has no synchronous streaming API to avoid that (`_processChunk` without a callback closes the compressor after one chunk).
- **Settings,** from recorded board patches (`output/` scripts, 200 streams):

  | Settings | Later patch | Fan-out of 200 | Memory per stream |
  |---|---|---|---|
  | brotli q5, window 64 kB | 57 B | 3.5 ms | 549 kB |
  | brotli q3, window 32 kB | 98 B | 1.9 ms | 362 kB |
  | gzip 6, window 32 kB, memLevel 8 | 118 B | 2.5 ms | 234 kB |
  | **gzip 6, window 16 kB, memLevel 6** (chosen) | 164 B | 2.1 ms | 165 kB |
  | gzip 6, window 8 kB, memLevel 5 | 232 B | 1.7 ms | 123 kB |

  With many open pages, memory matters more than the last hundred bytes per patch.
- **Off by default.** It pays on slow links (a 6 kB patch is 24 ms at 2 Mbit/s), not on a LAN.

## The catalog admin under load

`tools/perf/admin-load.sh` (`APP=admin` in `matrix.mjs`) runs `examples/admin/scripts/load-test.mjs`: N product lists open, one editor saving a product every second, as the edit page does. Every list re-queries on every change. `VARIED=1` gives every list its own query; `PG=1` puts the catalog and snapshots in Postgres.

```sh
node tools/perf/matrix.mjs 3 200 10 memory=APP=admin memory-varied=APP=admin,VARIED=1 postgres=APP=admin,PG=1 postgres-varied=APP=admin,PG=1,VARIED=1
```

| 200 lists | p50 | p95 | CPU | Renders in 10 s |
|---|---|---|---|---|
| memory, the same query | 213 ms | 366 ms | 46% | 2,010 |
| memory, varied queries | 149 ms | 255 ms | 35% | 2,010 |
| Postgres, the same query | 291 ms | 517 ms | 50% | 2,010 |
| Postgres, varied | 230 ms | 419 ms | 46% | 2,010 |

- **Before two fixes** every list rendered twice per change (4,010 renders), and p50 was 313 / 274 / 355 / 317 ms:
  - core rendered after every Message, also after `ChangedCatalog`, which only starts the query. A Message that leaves the Model unchanged now publishes nothing;
  - the admin created an `Intl.NumberFormat` for every price (7% of busy time).
- **Why slower than Dispatch:** each list waits for its own query, a Command between the change and the render; on Postgres also for the connection pool (400 queries per change).
- **Next lever, the app's:** lists showing the same query could share its result.
- Varied queries are faster because many lists do not change at all (1,250 of 2,000 page-changes sent no patch).

## Uploads

`examples/admin/scripts/upload-load.mjs`: K editors upload an image at the same moment, as the edit page does.

| 20 × 2 MB at once, 3 rounds | Answer p50 | p95 | RSS idle → peak → after |
|---|---|---|---|
| images in memory | 184 ms | 199 ms | 193 → 297 → 365 MB |
| images in Postgres | 196 ms | 298 ms | 190 → 240 → 241 MB |

- No failures. Oversized uploads are refused with 413 from their Content-Length.
- A 40 MB burst costs 50–100 MB at its peak: the multipart parts and the `File` objects are both in memory until `update` has the files. The upload limit bounds this per request; the number of concurrent uploads is not bounded yet.

## Soak

`tools/perf/soak.mjs` runs Dispatch for a long time with churn and samples memory and everything a session keeps (`programs.*.handlerTables`, `regions`, `gauges.sharedRegionKeys` in `/_hyper/metrics`).

**Two hours, 2026-10-26** (200 pages, 20 replaced per minute, 1 change/s, 40 page events/s):

| | After warm-up | At the end | Trend per hour |
|---|---|---|---|
| Heap (after GC) | 123.5 MB | 124.6 MB | +0.1 MB |
| RSS | 388 MB | 414 MB | +1.9 MB (range 315–723) |
| Handler tables | 19,600 | 19,740 | flat (~80 per session) |
| Regions | 3,915 | 3,915 | flat (15 per session) |
| Snapshot files | 256 | 262 | flat (live sessions only) |

No stream dropped, no event refused, render time 0.49–0.54 ms throughout. Other measurements ran alongside for parts of it (event-loop lag peaked at 154 ms then); memory was not affected.

## Where the time goes now

A profile at 1000 pages on one process, 1 change/s (`npm run perf:profile -- 1000`):
- The process is busy for ~25% of wall time: about 250 ms of CPU per change, spent in one burst.
- That burst is the latency: the last page is updated when the burst ends.

Self time of the busy part:

| Area | Share | What |
|---|---|---|
| hyper-effect core | ~20% | `session.ts` (region bookkeeping, intake, render orchestration), `region.ts`, `deps.ts` (value comparison of deps), the binding rewrite |
| Garbage collection | ~10% | |
| Effect runtime | ~10% | Fibers, the stream per connection, queues, the scheduler |
| Foldkit serializer | ~10% | `escapeAttributeValue`, `openElement`, `collectDataAttributes`, `serializeHtml` |
| Socket writes (`writev`) | ~6% | |
| App view code | ~5% | `board.ts`, `layout.ts`, crease/ui |
| parse5 | ~2–4% | Foldkit's `renderToString` still validates a stub per render, even in production |

**What changed since the first profile:**
- Stack capture (7%) is gone.
- `Match` no longer shows: the views that re-render rarely call it now.
- Key probing (half the busy time after nested regions, hidden inside `pipeArguments`) is gone since the filter widget sits in its own region.

## Levers not yet tried

By expected gain:

1. **Server hardware** for the multi-core numbers, before more work on cores.
2. **A leaner per-connection pipeline.**
   - Each connection runs `SubscriptionRef.changes` → sliding buffer → render → map → filter → merge with heartbeats → `encodeText`.
   - A push loop per session (render once, write to every connection of the session) would cut the Effect runtime share and some GC.
3. **Skipping Foldkit's `renderToString` frame.** In production it still builds a frame and validates a stub (parse5, 2–4%). Views without Submodels need no frame at all; views with them need only the boundary frames, not the validation.
4. **Skipping the frame render.**
   - The view function still runs completely on every update, although most regions are kept.
   - Region deps declared outside `view` (selectors) would let an update skip rendering entirely when no deps changed.
   - This is an API change; decide before 0.1.
5. **Compression** (experiment 4).
   - Brotli per stream would shrink 6.4 kB patches to a few hundred bytes.
   - Measure its CPU cost against the now-small render cost.
6. **Garbage collection.** About 10%. A larger young generation did not help (see Rejected). Fewer allocations per render (handler tables, strings, Effect fibers) is what is left.
7. **Foldkit upstream:**
   - a public serializer;
   - a cheaper `isVNode`;
   - stack capture off in production, so hyper-effect need not switch it off around views.
8. **Admission control** for overload: cap concurrent renders and shed presence-like updates first.

## Rejected

- **Render pacing by event-loop lag, then by utilization.** It delayed healthy fan-outs: p95 2.1–2.3 s, with missed updates. Conflation already prevents backlogs.
- **Sharing markup through `InnerHTML`.** Foldkit's serializer re-parses InnerHTML to validate it, which costs more than rendering the rows. `shared` uses placeholders instead.
- **Deps compared by reference.** Foldkit Message constructors copy their payload, so most deps changed every time. Deps are compared by value now.
- **Effect's `Equal.equals` for deps.** It hashes whole structures first. A direct walk for arrays and plain objects is cheaper; `Equal` is still used for Option and Data values.
- **A larger young generation** (`NODE_FLAGS=--max-semi-space-size=32` or `64`). At 1000 pages, within each round, it was within 5% of the default, which is noise. Not adopted.
- **More than 3 workers on this laptop.** Each extra busy core slows all the others (power limit); 4 workers measured worse than 3.

## Not measured yet

- **Server hardware** for workers (see [Multiple cores](#multiple-cores)).
- **The browser:** morph time, memory of long-lived pages, and how Datastar handles many region patches per second.
- **Real networks:** experiment 4 checked behaviour (proxies, HTTP/2, a shaping proxy with loss and resets; [deployment.md](deployment.md)), not latency over a real wide-area link.
- **Durable events** on Redis, on Linux file systems, and on a database outside Docker Desktop.
- **Compression** done by a proxy instead of the app.
