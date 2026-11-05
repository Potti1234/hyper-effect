# Dispatch

The hyper-effect demo: field incidents worked on by several dispatchers at once. It has a server-rendered board with crease/ui, a server-side toggle-group Submodel, live shared state and presence, and a MapLibre map as a Foldkit island. What to try is in the [root README](../../README.md#the-demo-dispatch).

```sh
npm start                # from the repo root, or here: builds CSS + islands, serves :3000
npm run check:dispatch   # needs a running server
npm run check:restart    # starts its own server on :3100
npm run start:cluster    # src/cluster.ts: a router on :3000 and one worker per core (WORKERS=n)
npm run load-test -- --sessions 200 --rate 1   # server started with HYPER_METRICS=1
npm run check:inputs     # IME, autofill and change-only fills while the page morphs
```

| Environment variable | Default | Use |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `DISPATCH_SECRET` | dev value | Signs the sign-in cookie |
| `HYPER_SNAPSHOT_SECRET` | dev value | Seals session snapshots in `.hyper-sessions/` |
| `HYPER_METRICS` | off | `1`: metrics routes on, page limits raised for load tests |
| `WORKERS` | cores | Workers of `src/cluster.ts` |
| `DISPATCH_AB_*` | on | Switch performance levers off (or compression on) for A/B runs; see `src/app/dispatch/levers.ts` |
| `DISPATCH_SESSIONS_DIR` | `.hyper-sessions` | Where `fileStore` keeps snapshots |
| `DATABASE_URL` | none | Postgres for snapshots, with `DISPATCH_AB_SNAPSHOTS=postgres` |

Set both secrets outside development: the dev values are in the source.

Tests (`test/`) cover what core's tests cannot: crease rendering, render equivalence for the board, and the security scans over island props and every Dispatch page.
