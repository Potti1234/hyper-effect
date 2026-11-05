# hyper-effect

**The Elm architecture on the server, on [Effect](https://effect.website).**

A page is a [Foldkit](https://github.com/foldkit/foldkit) program — Model, Message, `update`, `view`, Commands, Subscriptions — whose loop runs in a server session. The view is rendered on the server with Foldkit's `HtmlBuilder`, so [crease/ui](https://github.com/Potti1234/creaseui) components work unchanged. In the browser, [Datastar](https://data-star.dev) posts events and morphs in the re-rendered markup. Parts that need client-side reactivity (a map, a canvas) run as **islands**: real Foldkit programs in the browser, wired to the server page by two Schemas.

No client state to sync, no API layer, no JSON contract between front and back: one program per page, live for every viewer.

> **Status: experimental, pre-0.1.** The architecture is validated by three apps, 160+ tests and browser checks, but the API is not frozen, the first npm release is an alpha, and it builds on Foldkit's `experimental/server` and internals. See [where it stands](#project-status).

## Quick start

Requires Node 22.19+ (and Docker only for the Postgres checks).

```sh
npm install
npm start                 # Dispatch demo on http://localhost:3000 (builds CSS + islands bundle)
npm run start:admin       # catalog admin on http://localhost:3200
npm run create -- my-app  # a new app in apps/my-app from the template, then npm install
npm test                  # vitest across every workspace
npm run typecheck         # every workspace
```

Open the demo in two browsers, sign in with two names, and watch changes, presence and the map stay in sync.

## A page in a nutshell

```ts
export const program: Program<Model, Message, ClientMessage, Flags, Tasks> = {
  name: 'tasks',
  Model,                 // Schema: snapshotted, so sessions survive restarts
  ClientMessage,         // the only Messages a browser may post
  flags: request =>      // per page load: authenticate, then load data
    Effect.gen(function* () {
      const user = yield* requireUser(request)
      const tasks = yield* Tasks.use(store => store.current)
      return { user, tasks }
    }),
  init, update, view,    // plain Foldkit
  subscriptions,         // e.g. the store's change feed: every page updates live
  clientCommands: { FocusNewTask: () => ({ focus: '#task-title' }) }, // performed by the browser
}

// in the view: only this part re-renders and travels when its deps change
region(h, { id: 'new-task', deps: [model.draft, model.draftError], render: () => newTaskForm(model, h) })

// src/main.ts
HttpRouter.serve(Hyper.layer(TaskPage.program, { path: '/', principal: Auth.principal }))
```

Taken from [`apps/starter`](apps/starter), the app `create-hyper-effect` generates.

## Repository layout

| Path | What it is |
|---|---|
| [`packages/core`](packages/core) | `@hyper-effect/core`: `Program`, session runtime, server `HtmlBuilder`, Datastar bindings, ordered exactly-once intake, regions, uploads, key bindings, snapshot stores (file, SQL), security, compression, metrics. Test helpers at `@hyper-effect/core/testing`. |
| [`packages/island`](packages/island) | `@hyper-effect/island`: the island Schema contract, `Island.view` for server views, the browser custom element, and a Vite preset. |
| [`packages/create-hyper-effect`](packages/create-hyper-effect) | The app generator and its template (sign-in, live list, form, regions, Story/HTTP tests, Playwright check). |
| [`examples/dispatch`](examples/dispatch) | **Dispatch** — live incident board for several dispatchers: crease/ui on the server, a server-side Submodel, a MapLibre island, presence, restart survival, a multi-core router. |
| [`examples/admin`](examples/admin) | **Catalog admin** — CRUD with roles, URL-synced search/filter/sort/pagination, image uploads, edit conflicts, in-memory or Postgres (LISTEN/NOTIFY). |
| [`apps/starter`](apps/starter) | The template as generated. |
| [`apps/linear-clone`](apps/linear-clone) | A Linear clone built by an agent from only the skill and template; its [`EXPERIMENT.md`](apps/linear-clone/EXPERIMENT.md) is the friction log. |
| [`tools`](tools) | Load and profile scripts, a cluster balancer and checks, nginx and a bad-network shaper, throwaway Postgres, the crease/ui compatibility matrix. |
| [`.claude/skills/hyper-effect`](.claude/skills/hyper-effect/SKILL.md) | Agent skill: architecture, rules, workflow, API map, patterns, pitfalls. |
| [`docs`](docs) | Guide, roadmap, performance, deployment, compatibility, design proposals. |

All workspaces are TypeScript sources run with `tsx` (no build step yet) and share one copy of `effect` (4.1) and `foldkit` (0.170).

## Checks

Unit and property tests run with `npm test`. Browser checks drive Chromium (Playwright) against a running server:

| Command | What it checks |
|---|---|
| `npm run check:dispatch` | two dispatchers, random 0–300 ms POST latency, CSP enforced (needs `npm start`) |
| `npm run check:restart` | kills and restarts the server under an open page |
| `npm run check:inputs` | IME composition, autofill and change-only fills on a morphing page |
| `npm run check:admin` | two editors and a viewer against the admin (needs `npm run start:admin`) |
| `npm run check:cluster` | two Dispatch nodes behind a balancer, one killed mid-session |
| `npm run check:admin-nodes` | two admin processes on one Postgres (`npm run db:start` first) |
| `npm run check:compat` | renders every crease/ui demo on the server → [docs/compatibility.md](docs/compatibility.md) (needs crease checked out at `../crease`) |
| `npm run perf:load -- 200 1 15` | load test: pages, changes per second, seconds (`perf:profile` adds a CPU profile) |
| `cd apps/<app> && npm run check` | each app's own browser check (needs that app's `npm start`) |
| `npm run lint` | ESLint (typescript-eslint) over packages, apps and examples |
| `npm run check:pack` | builds the packages, stages them as published and imports every entry point from `dist` under plain Node |
| `npm run check:create` | after `check:pack`: `npm create hyper-effect` from the packed tarballs in an empty directory, then install, typecheck and test the app |
| `npm run check:crease` | compares the `src/ui` copies with creaseui at the commit in `tools/crease/upstream.json` |

Check artefacts (screenshots, logs, profiles) go to `output/`, which is git-ignored.

## Documentation

- [Guide](docs/guide.md) — how it fits together: the three ways a component can live, regions, islands, uploads, keyboard and browser effects, correctness mechanisms, security, performance, known limits.
- [Roadmap](docs/roadmap.md) — experiments, results and the path to 0.1.
- [Performance](docs/performance.md) — method, measurements, profile, levers tried and open.
- [Deployment](docs/deployment.md) — production mode, proxies, HTTP/2, multiple nodes, Postgres.
- [Compatibility](docs/compatibility.md) — which crease/ui components run on the server.
- [Design: latency](docs/design-latency.md) — local effects, forwarded replies, navigation within a session and prefetch; browser-run Submodels as the next step.
- [Hardening log](docs/hardening-log.md) — every check and latency measurement behind that work.
- [crease changes](docs/crease-changes.md), [crease journal](docs/crease-journal.md) — what building on crease/ui fed back into it.
- [Research notes](RESEARCH.md) — the original survey (htmx, Datastar, templ, Effect) and early decisions.

## Project status

**Done:** the server-side Elm loop; crease/ui rendered unchanged; server-side Submodels; Foldkit islands; Schema-validated forms; live multi-user state and presence; ordered, exactly-once and lossless event delivery across restarts and process failures (property-tested); region patches, nested and shared; uploads; URL-synced state; page-wide key bindings; multiple cores with per-session routing; Postgres for app state and snapshots; CSP, sealed snapshots, rate limits; the app template and agent skill.

**Measured (laptop, production mode):** one change reaches 200 open pages at p95 ≈ 95 ms on one process, ≈ 70 ms with 2 workers; 1000 pages ≈ 220 ms with 3 workers. Every interaction costs one network round trip plus ~20 ms.

**Screen-only interactions and navigation:** a closed set of local effects (show/hide/toggle, focus, dialogs, roving selection) runs in the browser and the server is told afterwards; forwarded Commands report back, so crease's styled dialogs run with their update on the server; Programs serve several paths and navigate within one session; speculation-rules prefetch without orphan sessions. At 80 ms RTT `j`/`k` went from 87 ms to 0 ms, opening a prefetched issue from 158 ms to 76 ms ([design-latency.md](docs/design-latency.md)).

**Foundations:** CI (typecheck, lint, tests, pack, creaseui drift, browser checks in production mode); `npm run build` emits `dist/` and `npm run check:pack` imports it under plain Node; production refuses development secrets (`secretFromEnvironment`); the creaseui copies are checked against a pinned creaseui commit.

**Open before 0.1:** API freeze (releases are `0.1.0-alpha.*` on the `alpha` dist-tag, see [releasing](docs/releasing.md)); browser-run Submodels for richer components such as pickers (design-latency section 6); upstream asks to Foldkit ([public serializer](docs/upstream/foldkit-public-serializer.md), supported injected `HtmlBuilder`) and Datastar (a CSP-safe mode, so `'unsafe-eval'` can go); the remaining type assertions. Not yet tested: Safari and mobile browsers, Caddy, HTTP/3, Redis, server hardware.

## License

[MIT](LICENSE)
