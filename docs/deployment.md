# Deploying hyper-effect

What a deployment needs, from what phase B verified (2026-10-26). Each point names the check or measurement behind it; what was not verified is listed at the end. The roadmap has [the results](roadmap.md#phase-b-deployable-2026-10-26).

## One process

- **Production mode:** `NODE_ENV=production`. It turns off markup validation and the development checks; development mode is 3–10× slower ([performance.md](performance.md#pitfalls)).
- **Secrets:** set `snapshotSecret` (and the app's own cookie secrets). The examples read `HYPER_SNAPSHOT_SECRET` and fall back to development values that are in the source.
- **Snapshots:** `Hyper.fileStore(directory)` on a local disk. Each file is replaced whole, so a process killed mid-write leaves the old snapshot, never part of one (`check:cluster`).
- **Events are durable by default** (`durableEvents`): an event is answered once its snapshot is written. On a slow disk this costs answer latency; see [performance.md](performance.md#durable-events).

## Behind a reverse proxy

`tools/net/nginx.conf` is a verified nginx configuration, HTTP/1.1 on one port and HTTP/2 over TLS on another (`tools/net/nginx.sh` runs it in Docker in front of port 3000). `check:dispatch` passes 24/24 through both.

- **Buffering needs no setting.** Event streams carry `X-Accel-Buffering: no`, which nginx obeys per response. Without that header, nginx's default buffering held every patch back and the check timed out waiting for the first live update.
- **Host:** pass the browser's host (`proxy_set_header Host $http_host`). Event posts must come from the page's origin, and without `trustProxy` that origin is checked against the `Host` header. Alternatively set `trustProxy` to the number of proxies and send `X-Forwarded-Host`.
- **HTTPS:** send `X-Forwarded-Proto`, so cookies get `Secure`.
- **Timeouts:** streams send a heartbeat every 15 s; any read timeout above that works (the configuration uses 1 h).
- **HTTP/2** works unchanged (the browser negotiated `h2`).
- **A dead upstream must not become an error status for session requests.** Datastar retries a request that fails, but takes a 502 as final, so the event would be lost. Reset the connection instead (as Dispatch's router and `tools/cluster/balancer.mjs` do), or let the proxy retry on another upstream: events carry sequence numbers, so a retried post is never applied twice.

## Compression

Region patches compress extremely well against each other: from one change to the next, most of their markup repeats.
- **In the app:** `compression: true`. Every event stream gets its own gzip compressor (16 kB window), flushed after each patch, so every patch is encoded against the earlier ones of the same stream.
- **Measured on Dispatch** (200 pages, 1 change/s; [performance.md](performance.md#compression)):
  - bytes on the wire fall 30×, from 1,040 to 35 kB/s; a 5.9 kB region patch travels as about 160 bytes;
  - each open page keeps about 155 kB more memory;
  - under that fan-out, patches leave a little later: p50 +43 ms, p95 +27 ms. Each compression waits for zlib's thread pool, and those callbacks run after the fan-out's renders.
- **When to turn it on:** for pages used over the internet, and mobile in particular. An uncompressed 6 kB patch takes about 24 ms on a 2 Mbit/s link, before any queueing, which costs more than the compression adds. On a LAN, or with a proxy that already compresses, leave it off.
- **Brotli** compresses these patches 2–3× better still, but keeps 360–600 kB per stream, so core uses gzip.
- **In the proxy:** not measured. A proxy compressing per response must flush after every event, or it delays patches the way buffering does.

## Several processes or machines

- **Route by session.** `Options.node` puts the process's name into session ids, and `nodeOfPath(path)` reads it back. `examples/dispatch/src/cluster.ts` is such a router for the cores of one machine (`check:cluster`). Cookie-sticky balancing works too (`check:admin-nodes`, `check:cluster`). Round-robin breaks sessions: two processes would serve one session at once.
- **A shared snapshot store:** `Hyper.sqlStore()` on Postgres (or any `SqlClient`). Writes are one upsert. Rows expire after `ttl` (match `snapshotTtl`) and are purged, which removes the snapshots of sessions whose process died. A killed process's sessions continue on another one from it (`check:admin-nodes`).
- **App state in the database, with a change feed.** `examples/admin/src/app/catalog/postgres.ts` is the reference:
  - every write runs in a transaction that also calls `pg_notify`, which Postgres delivers on commit, to every process;
  - each process listens once and turns notifications into a version its pages' Subscriptions watch;
  - edit conflicts are a conditional `UPDATE` on a revision; uniqueness is a constraint.
- **Files** (uploaded images) belong in the database or object storage, not in a process (`check:admin-nodes` serves an image from the process that did not receive it).
- **Commands in flight die with their process.** An HTTP call or write started by an answered event is not rerun elsewhere. Make such effects idempotent, or record the intent in the Model.

## Networks

`tools/net/shaper.mjs` is a TCP proxy that adds latency and jitter, stalls like a lost packet does, and resets connections at random times. Over 150 ± 100 ms, 5% stalls of 600 ms and half the connections reset, `check:dispatch`, `check:admin` and `check:inputs` pass. Resets hit streams (Datastar reconnects) and event posts (Datastar retries, and the sequence number deduplicates).

## Input

Client-owned inputs (bound with `OnInput`) handle IME composition and autofill (`check:inputs`):
- a composition is never overwritten by a morph, and the committed text reaches the server;
- an autofilled value submitted at once is part of the submit;
- a value filled with only a `change` event (some password managers) is announced as an input by the page script.

## Not verified yet

- Safari and mobile browsers: WebKit is not installed on the test machine.
- Caddy, HTTP/3, Kubernetes ingress controllers.
- A real wide-area network, beyond the shaping proxy.
- Redis as the snapshot store (no image on the test machine); `sqlStore` covers Postgres.
- Server hardware for the multi-core numbers ([performance.md](performance.md#multiple-cores)).
