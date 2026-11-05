# Linear

A clone of Linear's issue tracker built with hyper-effect: Foldkit programs whose loop runs on the server, on Effect, with Datastar in the browser. The experiment record (feature status, friction log, measurements, verdict) is in [EXPERIMENT.md](EXPERIMENT.md).

```sh
npm run build                                  # CSS
PORT=4100 node --import tsx src/main.ts        # http://localhost:4100 (NODE_ENV=production for production mode)
npm test                                       # Story tests of update, HTTP tests of the pages
npm run typecheck
node scripts/check.mjs                         # two people in Chromium against the running server
node scripts/measure.mjs 40                    # click → morph latency
node scripts/screenshots.mjs                   # screenshots/
```

Sign in with any name (Ada, Grace, Linus, Margaret, Alan and Katherine are seeded members).

| File | What it is |
|---|---|
| `src/main.ts` | The server: page layers, sign-in routes, static files, services, snapshot store |
| `src/app/issues/page.ts` | List and board (mounted at `/team/:team`, `/my-issues`, `/issues`): filters, search, picker, palette, new-issue dialog, keyboard, drag and drop |
| `src/app/issue/page.ts` | The issue page `/issue/:identifier`: inline edits, properties, comments, activity, presence |
| `src/app/store.ts` | The workspace (members, issues, comments, activity) with a change feed, and who views which issue |
| `src/app/domain.ts`, `seed.ts` | Schemas, validation, the URL query, seed data |
| `src/app/view/*` | Shell (sidebar), picker, icons, property items |
| `src/app/shortcuts/contract.ts` | The keyboard shortcuts (core `keyBindings`), shared by both pages |
| `src/ui`, `src/lib` | crease/ui components copied in |
| `test/`, `scripts/` | Tests, browser check, measurement, screenshots |

## Environment

| Variable | Default | Use |
|---|---|---|
| `PORT` | `4100` | Listen port |
| `APP_SECRET` | dev value | Signs the sign-in cookie |
| `HYPER_SNAPSHOT_SECRET` | dev value | Seals session snapshots in `.hyper-sessions/` |
