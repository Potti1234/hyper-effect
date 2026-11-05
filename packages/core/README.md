# @hyper-effect/core

Foldkit programs whose loop runs on the server, on Effect, rendered with Foldkit views and driven by Datastar in the browser.

```sh
npm install @hyper-effect/core@alpha effect foldkit
```

Before 0.1 the packages are published on the `alpha` dist-tag. To start a new app: `npm create hyper-effect@alpha my-app`.

```ts
import * as Hyper from '@hyper-effect/core'

HttpRouter.serve(
  Layer.mergeAll(
    Hyper.layer(Board.program, { path: '/', stylesheets: ['/styles.css'] }),
    Hyper.layer(Incident.program, { path: '/incidents/:id' }),
  ),
)
```

A `Program` is Foldkit's application shape plus what a server needs:
- a `name` for its endpoints;
- `Model` and `ClientMessage` Schemas (snapshots, unforgeable events);
- effectful, request-aware `flags`, which can fail with `PageNotFound` or `PageRedirect`.

## Exports

| Entry | Contents |
|---|---|
| `@hyper-effect/core` | `layer`, `Options`, `Limits`, `Program`, `PageRequest`, `PageNotFound`, `PageRedirect`, `RequestContext`, `ContentSecurityPolicy`, `Secret`, `region`, `shared`, `keyBindings`, `sampleLatest`, `memoizeLast`, `nodeOfPath`, `fileStore`, `sqlStore`, `foldkitUiCommands`, `metricsRoutes` |
| `@hyper-effect/core/binding` | Event-to-Datastar rewriting, for packages that render their own elements (islands) |
| `@hyper-effect/core/builder` | The server `HtmlBuilder` and `binderOf` |
| `@hyper-effect/core/testing` | `serve` (with the program's services as a Layer), `openPage`, `postEvent`, `openStream`, `readUntil`, `makeStore`, `waitForSnapshot`, `token`, `renderModel` |

## Options worth knowing

| Option | Default | What it does |
|---|---|---|
| `principal` | none | Who a request acts for; sessions are bound to it |
| `contentSecurityPolicy` | on | Nonce-based policy; add sources per directive, `reportOnly`, or `false` |
| `snapshotSecret` | none | Seals snapshots (AES-256-GCM); a list rotates secrets |
| `snapshotTtl` | `1 day` | Older snapshots no longer restore a session |
| `compression` | `false` | Brotli (or gzip) per event stream, one compressor per stream flushed after each patch |
| `durableEvents` | `true` | Answer an event only once it is in the snapshot store, so a failing process loses no answered event; `false` snapshots a quiet second later |
| `trustProxy` | `0` | Proxies whose `X-Forwarded-For` / `X-Forwarded-Host` entries count |
| `node` | none | This process's name when several serve one app: session ids become `<node>.<uuid>`, for routing (`nodeOfPath`) |
| `allowedOrigins` | `[]` | Extra origins allowed to post events |
| `limits` | see `server.ts` | Body size, event rate, page rate per client, upload bytes and files, sessions per visitor and per program |

`Program.snapshotDeps` (on the program, not an option) names the session's own state; outside events, snapshots are written only when it, or the intake position, changes.

Snapshots go to the `KeyValueStore` the app provides:
- `fileStore(directory)` keeps them in files, for development and for processes on one machine. Its writes replace a file whole (Effect's `KeyValueStore.layerFileSystem` writes in place, and a process killed mid-write leaves a snapshot that cannot be read).
- `sqlStore({ table, ttl, purgeEvery })` keeps them in a SQL database through Effect's `SqlClient` (the app provides the driver, such as `@effect/sql-pg`), for processes on several machines. Writes are one upsert; rows expire `ttl` after their last write, are never read after, and are purged periodically, which deletes the snapshots of sessions whose process failed.

Event streams carry `X-Accel-Buffering: no`, so nginx and proxies that honour it pass patches through at once; see [docs/deployment.md](../../docs/deployment.md).

Environment: `NODE_ENV=production` turns off markup validation, the region deps and id checks, and stack capture in views (`HYPER_VIEW_STACKS=1` keeps the latter).

Tests: `test/` (vitest), against the crease-free fixture in `test/fixtures/greeter.ts`.
