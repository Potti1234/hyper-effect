# Risks and open work

What can go wrong with the extension system as built on the branch `jellyware` (2026-11-24), what limits each risk today, and what would remove it; then how extension settings work and their risks, and the list of work left, with what is done.

## Risks

### Extensions run with the app's rights

Extension code runs in the server process. `requires` (`examples/jellyware/src/app/extensions.ts`) limits the services an extension's layer is typed against, not what its code can do at run time: a module can import `node:fs`, `node:child_process` or `process.env` and read the app's secrets (`APP_SECRET`, `HYPER_SNAPSHOT_SECRET`), its database, or the files of the machine.

- **Limits today:** extensions are written by the team's agent, which has no shell; every run is typechecked, scanned for credentials, and can be undone. Since 2026-11-24 every run also passes the **import check** (`importCheck` in `packages/jellyware/src/imports.ts`, rules in `examples/jellyware/src/app/extension-rules.ts`). It parses each script of a changed extension with the TypeScript parser and refuses:
  - imports of modules outside the allow-list: Effect's root module, Foldkit without `foldkit/http` and the experimental modules, and `#app/extensions`, `#app/domain`, `#app/store` and `#app/view/*`;
  - names a module is not allowed for. From `@hyper-effect/core` only the parts pages need, not `fileStore` or `secretFromEnvironment`; from `@hyper-effect/jellyware` only `Contributions`, `ExtensionSettings` and the slot and sidebar types, not the run pipeline;
  - relative imports out of the extension's folder, computed `import()` and `import.meta`;
  - the globals `process`, `globalThis`, `require`, `eval`, `Function`, `fetch`, `WebSocket` and similar, also written as `x['process']`;
  - Effect's `Config` and `ConfigProvider`, which read the environment.

  The failure goes back to the agent like a type error. `test/extension-rules.test.ts` checks that every extension in the folder follows the rules.
- **What the check misses:** it reads what the code says. Code built to get around it can (a chain of property accesses on an allowed object that reaches a constructor, for example), and an allowed module that gains a dangerous export opens a hole until the rules name it. Extensions written by hand and loaded at start are not checked; only runs are.
- **Removes it:** run each extension in a child process (`graft/node`, [design.md](design.md#8-trust)); it then gets only the services served to it.

### Anyone signed in can change the app

In the example, every signed-in member can start a run on `/extensions` and undo runs. A prompt can ask for code that reads data the member may not see, or that sends it elsewhere.

- **Limits today:** the example has no roles; it is a local demo.
- **Removes it:** runs only for a role (administrators), and an approval step between "checked" and "installed" in which a person reads the diff of the snapshot.

### The agent can write outside its stage

pi works in the stage with file tools only (read, edit, write, grep, find, ls). Since 2026-11-24 a pi extension, `examples/jellyware/src/pi-guard.ts`, checks every tool call (loaded with `--extension` next to `--no-extensions`):

- `write` and `edit` only inside the stage;
- `read`, `grep`, `find` and `ls` inside the stage or the repository, but not in `.jellyware` (other runs, and pi's credentials while it runs), `.git`, session snapshots or `.env` files;
- every other tool is refused.

It resolves a path the way pi does: relative to the stage, with `~` and a leading `@`, and through symbolic links. It then hands pi the resolved path, so pi opens exactly the file that was checked. Without its configuration it refuses everything.

- **What it misses:** `grep` and `find` searching a folder of the repository rely on ripgrep and fd skipping git-ignored folders, so a search of the repository root does not search `.jellyware`. Reading the app's other sources is allowed on purpose (the agent learns from them). The pipeline still hashes the app's `src/` before and after, as a second line.
- **Removes it fully:** pi in a container with only the stage writable and only the repository readable.

### The Codex access token lies in the app's folder while pi runs

Before each attempt the agent copies the Codex CLI's ChatGPT access token to `.jellyware/pi-agent/auth.json`. pi reads its credentials only from its agent folder, which also holds the search tools it downloads, so the folder stays. Since 2026-11-24 the file is deleted when pi stops (also when the run is interrupted). A file left by a server that stopped during an attempt is deleted when the server starts. The pi guard refuses reads in `.jellyware`, so the agent cannot read the file.

- **What is left:** while pi runs, the file is readable by anyone with access to the folder. The token is valid for about ten days. On Windows the `0600` file mode is not applied.
- **Removes it:** pi's credential commands (a key starting with `!` in its `auth.json`) would hand pi the token without a file. They are documented for API keys; whether they work for the `openai-codex` OAuth credential is not checked.

### One extension can stop the server

An extension that loops without yielding, allocates without bound, or calls `process.exit` stops every page of the app, not only its own. Graft's `Failed` state and retries cover failures, not a blocked event loop.

- **Removes it:** the child process of the first risk, with a watchdog (Powermove kills sandboxed extensions that stop answering for 8 seconds).

### Events during a swap

While the new version of an extension is mounted and the old one not yet closed, an event goes to the new version, which restores the session from its snapshot; the old version's final snapshot can then overwrite the newer one. The window is the time between the two steps of a swap, usually milliseconds.

- **Removes it:** let the page host hand a session over: the old version writes its final snapshot first, then requests for the session go to the new version.

### Old versions stay in memory

Every load imports the extension's modules under a new URL. Node never frees a module, so each version stays in memory until the server restarts. Not measured yet.

- **Limits today:** a restart frees them.
- **Removes it:** measure memory per version; then the child process (a restarted process loses its old modules), or periodic restarts.

### One slow card hides the others in its slot (fixed)

A slot shows once every card in it has content (`Stream.zipLatestAll`). A card whose stream never emitted used to keep the whole slot empty. Since 2026-11-24 a card without content after `cardTimeout` (one second by default; `Contributions.make({ cardTimeout })`) shows as "Loading…" until its content comes, and the other cards show. On the issue page the first render waits 300 ms for the cards; the Subscription fills them in after that.

### Commands trust the extension to check rights

The issue page runs only actions it shows (they are in its Model), so a browser cannot invent a command or its arguments. Whether the member may do what the command does is the command's own check, as `related.mark-urgent` checks that the issue exists. A command that does not check lets every member who sees the card do it.

- **Removes it:** commands that declare the role they need, checked by the host before `run`.

### Undo restores files, not data

Undoing a run puts the extension's files back. Data the extension changed while it ran (an issue marked urgent, an issue taken in Triage) stays changed.

- **Accepted for now:** this matches Powermove, where panel actions also fall outside snapshot rollback. State it on the undo button.

### Only changed extensions are typechecked

A run typechecks the extensions it changes. When the app's own modules change, unchanged extensions are checked only by `npm run typecheck` (the example's `tsconfig.json` includes `extensions/`); a server started without it loads them, and one that no longer fits fails to load and shows as failed on `/extensions`.

- **Removes it:** run the typecheck in CI, and typecheck the extensions when the server starts in production.

### One server, one folder

Extensions, runs and the stylesheet are files on the server's disk. Two servers behind a load balancer would each load their own `extensions/` and keep their own runs.

- **Removes it:** extensions and runs in the shared store (Postgres), and a change feed that tells every server to load a new version.

### Graft is young

`@graftland/graft` 0.7.0 was released on 2026-11-16 and rewrote 0.6.0's API. It is pinned and used only through `packages/jellyware/src/graft.ts` ([graft.md](graft.md#decision)). Used so far: the graph, `mount` with `requires`, and mount states.

## Settings for extensions (built 2026-11-24)

An extension's settings are values people change while the app runs, such as how many related issues a card shows. For testing, every signed-in member may change them on `/extensions`.

- **Declared in the manifest.** `extension.json` has `settings`: per key a `type` (`string`, `number` with optional `min` and `max`, `boolean`, `select` with `options`), a `label`, a `default` and an optional `description` (`SettingSpec` in `packages/jellyware/src/settings.ts`).
- **Stored in the app's store** under `jellyware/settings/<extension>` (the app's `KeyValueStore`, `.hyper-sessions/` in the example), so they survive restarts and new versions. Stored values that no longer fit their declaration fall back to the default; keys no longer declared are not given to the extension.
- **Given to the extension while it is built** as `ExtensionSettings` (`settings.number('max')`, `string`, `boolean`).
- **A change loads the extension again** with the new values, the way a change of its files does: the new version is mounted next to the running one and replaces it once it is built. When the extension fails with the new values, the running version stays, the old values are stored again, and the change is recorded as *put back* with the error. `Extensions.configure` in `packages/jellyware/src/loader.ts`.
- **Undo.** Every change is kept in a history (`jellyware/settings-history`, the last 100). An applied change can be undone, newest first per extension, while the extension still has the values it set.
- **Edited on `/extensions`:** a form per extension, built from the declaration; the history below the extensions, with undo.

`extensions/related` declares a card title, how many issues it shows (1 to 20 by its declaration) and whether it offers "Mark urgent". It fails with more than 10, so "put back" can be tried; the browser check does, and sees another person's open issue page keep the earlier card.

Not as designed above: the values are not a Graft publication. `publication.set` rebuilds the extension in place, so a value it fails with would take it down until someone puts the old value back. Loading a new version next to the running one keeps the extension running throughout, and the "put back" comes from the loader for free.

Not built yet: secret settings (never sent to a browser, the stage or the agent), roles for who may change settings, and settings per workspace or member (Graft realms).

### Risks of settings

- **Everyone can change them** in the example, as asked for testing. A setting that controls what a command does, or what a card shows, changes it for everybody.
- **A value can be wrong without failing.** "Put back" covers values the extension fails to build with; a value it accepts but that makes it show or do the wrong thing goes live. Undo covers that case by hand.
- **Undo restores values, not data**, as with runs.
- **Each change reloads the extension**, so open pages of the extension reconnect (as on any swap), and the swap risks above apply.

## The list

Everything left, by size. Items 1 to 4 were done on 2026-11-24, in this order; the risks above describe what each does and what it misses.

### Small fixes that close known risks

| # | Work | Status |
|---|---|---|
| 1 | **The Codex token only while pi runs.** Delete `auth.json` when pi stops, and at start if a stopped server left one. | Done: [the token risk](#the-codex-access-token-lies-in-the-apps-folder-while-pi-runs) |
| 2 | **Import allow-list in the checks.** Allowed modules and names, no process or network globals, no computed `import()`, no `import.meta`. | Done: [extensions run with the app's rights](#extensions-run-with-the-apps-rights) |
| 3 | **pi writes only in the stage.** A pi extension that checks every tool call. | Done: [the agent can write outside its stage](#the-agent-can-write-outside-its-stage) |
| 4 | **A time limit per slot card.** A slow card shows "Loading…"; the others show. | Done: [one slow card](#one-slow-card-hides-the-others-in-its-slot-fixed) |

### Medium

| # | Work | Why | Where it was described |
|---|---|---|---|
| 5 | **Roles and approval.** Runs and settings only for administrators. An approval step between "checked" and "installed" in which a person reads the diff. Commands that declare the role they need, checked by the host before `run`. | [Anyone signed in can change the app](#anyone-signed-in-can-change-the-app), [commands trust the extension](#commands-trust-the-extension-to-check-rights) | above |
| 6 | **A generated guide for the agent.** The loaded extensions, their slots, commands and settings, written for pi before each run, as bb's `plugin-commands-skill.ts` does. Fewer wrong guesses, fewer retries. | Runs took two attempts each so far | [prior-art.md](prior-art.md#agent-pipeline) |
| 7 | **More slots.** Actions on selected rows of the issue list, the command palette, the board. | Extensions can add to only one place of the app's pages today | [design.md](design.md#4-slots-in-existing-pages) |
| 8 | **Better checks.** The extension's own Story and Scene tests in the checks. The agent declares what it changed, and a mismatch with the diff goes back to it (Powermove). | A typecheck does not show a page that renders the wrong thing | [design.md](design.md#6-the-agent-pipeline), [prior-art.md](prior-art.md#agent-pipeline) |
| 9 | **More settings.** Secret settings (never sent to a browser, the stage or the agent); settings per workspace or member (Graft realms). | Extensions that call other services need keys | [settings](#settings-for-extensions-built-2026-11-24) |
| 10 | **Smoother swaps and runs.** The page host hands each open session from the old version to the new one, so no snapshot is overwritten. Runs queue or run side by side instead of one at a time. | [Events during a swap](#events-during-a-swap); a long run blocks the next | `packages/jellyware/src/changes.ts` |

### Large

| # | Work | Why | Where it was described |
|---|---|---|---|
| 11 | **A child process per extension**, with a watchdog | Isolation (the real fix for item 2), memory of old versions, a blocked event loop | [design.md](design.md#8-trust) |
| 12 | **Data and migrations for extensions.** Tables of their own with append-only migrations (bb) | Extensions keep their data in the app's stores today | [design.md](design.md#7-data-and-migrations) |
| 13 | **Browser code in extensions.** Islands built with Vite, with shared runtime shims (bb, Powermove) | Charts, editors and drag previews need the DOM | [design.md](design.md#5-stylesheets) |
| 14 | **Several servers.** Extensions and runs in the shared store (Postgres); a change feed tells every server to load a new version | [One server, one folder](#one-server-one-folder) | above |
