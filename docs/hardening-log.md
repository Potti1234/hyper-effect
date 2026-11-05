# Hardening and latency log

Everything run to verify the local effects, forwarded replies, navigation, prefetch, secret guard, packaging, lint, CI and drift work. Latency figures are at 80 ms RTT through `tools/net/shaper.mjs` (40 ms each way) against the Linear clone in production mode, unless noted.

## Automated

| What | Command | Result |
|---|---|---|
| Type check, all workspaces | `npm run typecheck` | passes |
| Lint (errors fail, type assertions warn) | `npm run lint` | 0 errors, 57 assertion warnings |
| Unit, property and Story tests | `npm test` (Vitest) | 179 passed, 3 skipped (Postgres) |
| Local effects, reply forwarding | `packages/core/test/local.test.ts`, forwarding tests | pass |
| Navigation: several paths, `onUrlChange`, fallback loads, redirects, external and protocol-relative URLs rejected, no `onUrlChange` | `packages/core/test/navigation.test.ts` | 6 pass (with prefetch) |
| Prefetch: speculation rules, no session held, events refused until the stream opens, session from the URL | `packages/core/test/prefetch.test.ts` | pass |
| Secret guard: development fallback, production refuses missing/short secrets | `packages/core/test/secrets.test.ts` | 2 pass |
| Linear clone Stories: local selection, unknown row ids ignored, one Program across lists | `apps/linear-clone/test` | 26 pass |
| Packages build and import under plain `node` | `npm run build`, `npm run check:pack` | core and island: 4 entry points each import from `dist`, both pack |
| creaseui copies against creaseui `39bde3c8` | `npm run check:crease` | 40 copies, 30 identical, 10 recorded differences |

## Browser (Chromium, Playwright)

| What | Command | Result |
|---|---|---|
| Linear clone, development secrets | `apps/linear-clone: npm run check` | 52/52 |
| Linear clone, `NODE_ENV=production` with real secrets | same, against `PORT=4101` | 50/50 |
| Starter, `NODE_ENV=production` with real secrets | `apps/starter: npm run check` | 11/11 |
| New checks in the Linear script | local `j`/`k` selection; styled shortcuts dialog (`?`): focus inside, background `inert`, Escape closes, focus returns; sidebar navigation in the same session; back button | pass |
| End-to-end pass at 80 ms RTT (production mode, Chromium) | manual, testing agent | Found and fixed: Back from an issue page reused the cached list document and its session, so shortcuts were dropped (now `Cache-Control: no-store`, plus a reload on a back/forward-cache restore); Escape left focus on the body when the opening render had already moved focus into the dialog. Passed: local selection 0.7–1.5 ms, pickers target the new selection, styled dialog trap/inert/scroll lock, cross-tab updates while the dialog is open, sidebar navigation and history, Ctrl/middle-click, prefetch (issue opened in 47 ms), production secret guards. Holding J moves once (key repeat is ignored). |

## Latency (80 ms RTT)

| Interaction | Before | After |
|---|---|---|
| `j`/`k` selection | median 87 ms, p95 90 ms | median 0 ms, p95 8 ms |
| Status change, actor sees it | — | median 93 ms, p95 97 ms (unchanged by design) |
| Status change, watcher sees it | — | median 95 ms, p95 109 ms |
| Picker rendered / input focused | — | median 88 ms, p95 103 ms (still a round trip) |
| Navigate between lists, same session | full page load | about 151 ms median (browser loop, click to morph); one resource probe: `/nav` answered at about 83 ms, morph at 94–100 ms |
| Open an issue, cold | about 158 ms median | — |
| Open an issue after resting on its row (prefetch) | — | about 76 ms median |

The loops differ in what they time (event to morph, click to settled page), so compare figures within a row, not across rows.

## Not covered

- Safari and mobile browsers (no WebKit on the test machine).
- Redis as snapshot store, Caddy, HTTP/3, a real wide-area network, server hardware.
- The admin, Dispatch, restart, cluster and Postgres multi-node checks were not re-run for this work; CI runs the Linear clone and starter checks.
- `check:compat` still treats forwarded Commands with replies as skipped (see [design-latency.md](design-latency.md) section 4).
