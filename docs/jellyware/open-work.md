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
- **Since 2026-11-25** every extension runs in a process of its own ([extensions in their own process](#extensions-in-their-own-process-built-2026-11-25)): what the import check misses, Node's permission model stops (no file outside its bundle, no network, no child processes, none of the server's environment), and it reaches the app only through the services the app lists for it.
- **What is left:** the services it is given are real power. `Workspace.update(changes, actorId)` takes the acting member from the caller, so an extension can change issues in any member's name; the app decides which members it shares (`src/app/remote.ts` leaves out `setRole` and `remove`). An app that wants more passes the member from the request instead of trusting the extension.

### Who may change the app (roles and review since 2026-11-24)

A prompt can ask for code that reads data the member may not see, or that sends it elsewhere. Until 2026-11-24 every signed-in member could start runs, undo them and change settings on `/extensions`.

- **Limits today:**
  - **Roles.** Members of the example have a role, `admin` or `member` (`Member.role` in `examples/jellyware/src/app/domain.ts`). Ada is the seeded administrator; a new name joins as a member. Only administrators prompt, approve, reject and undo runs, change settings, and give or take the role (the "People" list on `/extensions`); the workspace keeps at least one administrator. The workshop's update checks the role for every Message a browser posts, from the member as the server knows them. Members see the runs, their diffs and the extensions.
  - **Review.** With `review: true` (`Changes` options, on in the example) a run whose checks pass waits in *Waiting for review*. Its live folders are copied to `before/` then, and the page shows a line diff of every changed file (`diff` in `packages/jellyware/src/diff.ts`, three lines of context, 400 lines per file at most). An administrator approves it, which installs it as before, or rejects it, which changes nothing. The run records who decided. A run waiting for review keeps waiting across restarts.
- **What it misses:**
  - The author may approve their own run; the point is that a person reads what the agent wrote, not only what they asked for. Requiring a second administrator is a check on `reviewer !== author` in the workshop.
  - An extension that fails to build at approval is put back and the run fails; the agent is no longer asked to fix it, as it is without review. Run the prompt again.
  - If a live extension changed while the run waited, approval fails, as an install did before.
  - The diff shows code, and a reviewer can miss what it does. The import check and the typecheck ran before; the reviewer is the third line, not the only one.
  - Roles live in the example's in-memory workspace: a restart brings back the seeded roles. Sign-in is still any name, so anyone who types "Ada" is the administrator. A real app takes roles from its identity provider.

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

### One extension can stop the server (fixed 2026-11-25)

An extension that looped without yielding, allocated without bound, or called `process.exit` stopped every page of the app. Now it stops its own process: a watchdog asks every second, and a process that does not answer within five seconds is killed and the extension shows as failed with "did not answer for 5 seconds (a blocked event loop?)". A test blocks an extension's event loop and sees exactly that; the app keeps serving.

- **What is left:** a failed extension stays failed until its files or settings change, or the server restarts; no automatic restart with backoff yet.

### Events during a swap (fixed 2026-11-25)

While the new version of an extension was mounted and the old one not yet closed, an event could reach the new version, which restored the session from its snapshot; the old version's final snapshot then overwrote the newer one.

Since 2026-11-25 the page host hands sessions over (`packages/core/src/page-host.ts`). When another version takes over a page's requests (a newer one is mounted, or the newer one closes and reveals the older), requests wait for a moment, those already running finish, the version that stops serving closes its live sessions with their final snapshots (`drain`, returned by `servedPage` in `server.ts`), and only then is the new router installed. A new router that does not fit (a path collision) is refused before anything is drained. A test posts an event to the new version while the old one is still mounted, then closes the old one: the snapshot keeps the new state (it failed before the change).

- **What is left:** an event stream that was answered by the old version just before the hand-over started can reach it once more; the window is the time between checking the gate and reading the router, microseconds. Requests wait while the old version writes its snapshots, a few milliseconds per open session.

### Old versions stay in memory (fixed 2026-11-25)

Every load used to import the extension's modules under a new URL into the server, where Node never frees them. Each version now is a process of its own, stopped after the swap: its modules leave with it. In-process loading (`JELLYWARE_ISOLATION=0`) still keeps them.

### One slow card hides the others in its slot (fixed)

A slot shows once every card in it has content (`Stream.zipLatestAll`). A card whose stream never emitted used to keep the whole slot empty. Since 2026-11-24 a card without content after `cardTimeout` (one second by default; `Contributions.make({ cardTimeout })`) shows as "Loading…" until its content comes, and the other cards show. On the issue page the first render waits 300 ms for the cards; the Subscription fills them in after that.

### Commands trust the extension to check rights (roles since 2026-11-24)

The issue page runs only actions it shows (they are in its Model), so a browser cannot invent a command or its arguments. Since 2026-11-24 a command can name the roles that may run it (`roles: ['admin']` in `Contributions.command`). The registry asks the app for the member's roles (`Contributions.make({ rolesOf })`, `rolesOf` in `examples/jellyware/src/app/extensions.ts`) before `run`, and leaves the action out of the cards of a member without one. Without `rolesOf`, commands that name roles are refused to everyone.

- **What is left:** a command without `roles` runs for every member who sees the card, and finer checks (may this member change this issue) are still the command's own. The agent's instructions and `AGENTS.md` tell it to name `roles` for commands only administrators should run. An extension runs in the server and can call `Contributions.run` with any member id; only a child process per extension (item 11) stops that.

### Undo restores files, not data

Undoing a run puts the extension's files back. Data the extension changed while it ran (an issue marked urgent, an issue taken in Triage) stays changed.

- **Accepted for now:** this matches Powermove, where panel actions also fall outside snapshot rollback. State it on the undo button.
- **An extension's own tables too** ([data of extensions](#data-of-extensions-built-2026-11-25)): undo keeps their rows, and a migration an undone run applied stays applied. The older version does not know its table; a later version must keep that migration where it is and add new ones after it.

### Only changed extensions are typechecked

A run typechecks the extensions it changes. When the app's own modules change, unchanged extensions are checked only by `npm run typecheck` (the example's `tsconfig.json` includes `extensions/`); a server started without it loads them, and one that no longer fits fails to load and shows as failed on `/extensions`.

- **Removes it:** run the typecheck in CI, and typecheck the extensions when the server starts in production.

### One server, one folder

Extensions, runs and the stylesheet are files on the server's disk. Two servers behind a load balancer would each load their own `extensions/` and keep their own runs.

- **Removes it:** extensions and runs in the shared store (Postgres), and a change feed that tells every server to load a new version.

### Graft is young

`@graftland/graft` 0.7.0 was released on 2026-11-16 and rewrote 0.6.0's API. It is pinned and used only through `packages/jellyware/src/graft.ts` ([graft.md](graft.md#decision)). Used so far: the graph, `mount` with `requires`, and mount states.

## Settings for extensions (built 2026-11-24)

An extension's settings are values people change while the app runs, such as how many related issues a card shows. Administrators change them on `/extensions` (every signed-in member could until roles came, 2026-11-24).

- **Declared in the manifest.** `extension.json` has `settings`: per key a `type` (`string`, `number` with optional `min` and `max`, `boolean`, `select` with `options`), a `label`, a `default` and an optional `description` (`SettingSpec` in `packages/jellyware/src/settings.ts`).
- **Stored in the app's store** under `jellyware/settings/<extension>` (the app's `KeyValueStore`, `.hyper-sessions/` in the example), so they survive restarts and new versions. Stored values that no longer fit their declaration fall back to the default; keys no longer declared are not given to the extension.
- **Given to the extension while it is built** as `ExtensionSettings` (`settings.number('max')`, `string`, `boolean`).
- **A change loads the extension again** with the new values, the way a change of its files does: the new version is mounted next to the running one and replaces it once it is built. When the extension fails with the new values, the running version stays, the old values are stored again, and the change is recorded as *put back* with the error. `Extensions.configure` in `packages/jellyware/src/loader.ts`.
- **Undo.** Every change is kept in a history (`jellyware/settings-history`, the last 100). An applied change can be undone, newest first per extension, while the extension still has the values it set.
- **Edited on `/extensions`:** a form per extension, built from the declaration; the history below the extensions, with undo.

`extensions/related` declares a card title, how many issues it shows (1 to 20 by its declaration) and whether it offers "Mark urgent". It fails with more than 10, so "put back" can be tried; the browser check does, and sees another person's open issue page keep the earlier card.

Not as designed above: the values are not a Graft publication. `publication.set` rebuilds the extension in place, so a value it fails with would take it down until someone puts the old value back. Loading a new version next to the running one keeps the extension running throughout, and the "put back" comes from the loader for free.

### Secret and member settings (built 2026-11-25)

- **Secret settings** (`"type": "secret"`, no default), for keys of other services. The loader stores them encrypted (AES-256-GCM, key from `secretKey`, in the example `JELLYWARE_SECRETS_KEY`; `packages/jellyware/src/secrets.ts`) and gives them to the extension only as `Redacted` values (`settings.secret(key)`, `settings.hasSecret(key)`); `values` and the typed reads hold none. Everywhere else a secret is set or not set: the statuses a page shows, the history (a short mark per stored value, `(secret 3f2a91)`, which says nothing about the secret), the agent's guide. Extension files hold no values, so the stage has none. On `/extensions` it is a password field that starts empty: left empty it keeps the value, "Remove" clears it. Undo works as for other settings. A value the key cannot open (the key changed) is given to the extension as not set, with a warning in the log. `extensions/triage` declares one ("Support inbox token") and its page says only whether it is set.
- **Member settings** (`"scope": "member"`): the administrator's value is the default, and every member may set their own under "Your settings" on `/extensions` (any member, not only administrators), or go back to the defaults. A member's value does not build the extension again; the extension reads the values of the member it serves while it runs, `settings.forMember(memberId)`, a stream. Values that no longer fit the declaration fall back to the default. `extensions/related` makes `max` a member setting: Grace's card shows one issue while Ada's shows ten.

- **What secrets miss:** the extension gets the plain value and runs in the server, so code that wants to leak it can; the import rules and the review are what stand against that (see [extensions run with the app's rights](#extensions-run-with-the-apps-rights)). Extensions cannot call other services yet (`fetch` is refused), so a key is of use only once the app offers a service for outbound calls. A secret typed into the form travels in the page's session until it is saved; session snapshots are encrypted too.
- **What member settings miss:** no history and no undo (a member's own preference; "Use defaults" resets it). A member setting cannot make the extension fail with a value, so there is no put-back either: the extension must cope with every value the declaration allows (`related` caps `max` at 10).
- **Not built: settings per workspace.** The example has one workspace. Several would want a variant of an extension per workspace, which is what Graft's labelled realms are for ([graft.md](graft.md)): one mount per workspace with its own settings. Per member, one mount each would not scale; values read at use time do.

### Risks of settings

- **A change reaches everybody.** A setting that controls what a command does, or what a card shows, changes it for every member who has no value of their own; only administrators can make it.
- **A value can be wrong without failing.** "Put back" covers values the extension fails to build with; a value it accepts but that makes it show or do the wrong thing goes live. Undo covers that case by hand.
- **Undo restores values, not data**, as with runs.
- **Each change reloads the extension**, so open pages of the extension reconnect (as on any swap), and the swap risks above apply.

## The agent's guide (built 2026-11-24)

Before each run the app writes a guide to what it has now and appends it to pi's instructions (after bb's generated plugin-commands skill). `guide` in `packages/jellyware/src/guide.ts` makes it from the running app, not from the files:

- **Pages** with their paths: the app's own (the app names them, `appPages`) and every page the page host serves, with the extension that mounted it.
- **Slots** the app's pages offer, with where they show, how to add a card and what its context holds (the app describes them, `slotsForGuide` in `examples/jellyware/src/app/extensions.ts`), and the cards in each now.
- **Commands** and who may run them; **sidebar entries** with their links.
- **Per extension:** name, version, state, description, what it adds, its settings with their types and values, and the error of one that failed.

Every id and path in it is taken, so the agent picks free ones instead of guessing. To credit each thing to its extension, the loader provides the extension's id while it builds it: `CurrentExtension` for the registry (`Contributions.inventory`), and core's `PageOwner` for the page host (`PageHost.pages`).

- **Seen so far:** the first run with the guide ("a card with the comment count, and a button for administrators only") passed every check in one attempt, in 51 seconds, twice. It used the slot, a new card id and `roles: ['admin']` as the guide describes them. The runs before the guide took two attempts each; two runs are not a measurement.
- **What it misses:** it lists what runs, so an extension whose folder has no valid manifest does not appear. It says nothing about the app's stores and domain beyond what the instructions name; the agent still reads those files.

## Slots and what can be customized (built 2026-11-24)

The issue lists offer two slots besides the issue page's cards (`issue.sidebar`):

- **`issues.palette`: entries in the command palette** (Ctrl+K). The content is the same `SlotContent` as a card: each action becomes an entry that runs its command, each item with a path of the app an entry that opens it, and the title is the group. The context names the selected issue (j/k), so this is also where actions on the selected row go: a group titled with its identifier is listed with the issue's own actions ("Change status of ENG-11…", "Mark ENG-11 urgent"). The palette reads the slot only while it is open. The browser posts the entry's value; update runs only entries the open palette offers.
- **`issues.badges`: badges on rows and board cards.** A new kind of entry in the registry, `Contributions.badges({ slot, id, content })`, whose stream gives `{ target, label, tone }` per issue; `slotBadges` merges every extension's badges. Rows and cards are shared regions (rendered once for everyone), so badges have no member in their context and look the same to everyone.

References: `extensions/related` adds "Mark <issue> urgent" for the selected issue, `extensions/standup` an entry "Open Stand-up", and the new `extensions/stale` a badge "Stale 12d" on open issues unchanged for a number of days (a setting, 10 by default).

**What can be customized.** As bb lists a plugin's capabilities, `/extensions` shows "What you can customize": every way an extension can change the app (pages, cards on an issue, the command palette, badges, settings), where each shows, a link to see it, which extensions fill it now, and for administrators an example prompt that fills the prompt field. Each loaded extension lists what it adds ("Adds: page /standup · sidebar entry "Stand-up" · command palette"). The list is one constant, `CUSTOMIZATIONS` in `examples/jellyware/src/app/extensions.ts`, which the agent's guide reads too; a new slot goes there. What fills each comes from `Contributions.inventoryChanges` and `PageHost.pages`.

- **Not built:** a board column slot (a summary per column), and acting on several selected rows at once: the list selects one row at a time.
- **Badges cost per session:** every open list runs each extension's badge stream once. A badge stream that recomputes all issues on every workspace change (as `stale` does) is fine at this size; a large workspace would share one stream per extension.

## Better checks (built 2026-11-24)

A typecheck does not show a page that renders the wrong thing, and an agent can change more than it meant to. Two checks were added.

- **The extensions' own tests.** An extension brings tests next to its code (`extensions/<id>/*.test.ts`): Story for a page's update, Scene for its view, plain assertions for what a card or badge shows. `npm test` runs them with the app's tests (`vitest.config.ts` includes `extensions/`), and every run runs the tests of the extensions it changed on its snapshot (`extensionTests` in `examples/jellyware/src/app/agent.ts`, after the import rules and the typecheck). The failures go back to the agent with paths as it knows them. `standup/page.test.ts`, `stale/extension.test.ts` and `related/extension.test.ts` are references, and the agent's instructions ask for tests.
  - Tests are agent code that runs before anyone reviewed it. They follow the import rules (no `process`, `node:fs`, `fetch` …) with the test runner, `@hyper-effect/core/testing` and `#app/seed` added for test files (`testAllow`), and they run in a child process whose environment has none of the server's variables, only `PATH` and the like (checked: a test reading `APP_SECRET` gets nothing).
  - An extension without tests passes; a page whose tests do not cover what was asked for passes too. The reviewer still reads the diff.
- **The agent says what it changed** (after Powermove). With `declaredChanges` (`Changes` options, on in the example) the agent's answer ends with `Changed: <ids>` (or `Changed: none`). It must name exactly the extension folders that differ from the live ones; otherwise nothing is checked or installed and the agent hears what does not fit ("Changed but not named: stray. If you did not mean to change them, put them back as they were."). This counts as an attempt. The line is not kept in the run's summary. `parseDeclared` and `declaredMismatch` in `packages/jellyware/src/changes.ts`.

- **Seen so far:** asked for "a blue badge 'Unassigned' on open issues nobody is assigned to", pi wrote the extension and a test for every status with and without an assignee, named it in its `Changed:` line, and passed every check in one attempt, in 68 seconds. The browser check runs a scripted change that breaks `stale`'s test; the run fails after three attempts with the failing assertion.

## Runs side by side (built 2026-11-25)

A run used to wait for every run before it, so one long run held up the rest. `Changes` takes `concurrency` (default 1; the example uses 3): that many runs work at once, started in the order they came; the rest wait in "Queued". Each run has its own stage and snapshot, installs take turns, and a run whose extensions changed since it started is refused at install ("shared changed since this run started"), so two runs on the same extension never both go live unnoticed. A test runs two at once, queues a third, and checks that the second of two changes to one extension is refused.

What several runs share had to cope: pi's credentials file now exists while at least one pi runs (written by the first, deleted by the last), and the typechecks take turns, as they share one incremental build file. The extensions' tests run side by side.

- **What is left:** a refused run must be run again by hand; it could instead start again from the new live files.

## Extensions in their own process (built 2026-11-25)

With the loader's `isolation` option (on in the example; `JELLYWARE_ISOLATION=0` turns it off) each version of an extension runs in a process of its own (`packages/jellyware/src/isolation/`):

- **Bundled and fenced.** esbuild bundles the extension, the app modules and packages it imports, and the process runtime into one file in a folder of its own (`.jellyware/bundles/<id>/…`, removed when the version stops; about 2 MB and 0.2 s). The process starts with Node's permission model and may read that folder only: no other file (the repository, `.jellyware`, `.env`), no network (`--allow-net` is not given), no child processes or workers. Its environment holds `PATH` and the like, and what the app adds: a snapshot secret derived for this extension, never the server's.
- **A channel both ways** (`bridge.ts`, over Node's IPC): calls, streams and registrations that last a scope, each way. Failures cross as plain data, a tagged failure keeps its `_tag`.
- **What the process gets** (`child.ts`): stand-ins of the app's services as the app describes them (`remoteService(Workspace, { current: 'value', changes: 'stream', update: 'call', … })`, in a module both sides import, `src/app/remote.ts`), the registry (entries live in the server, so the app's pages and the guide see them; content and commands are asked of the process and checked against their Schemas when they come back), a key-value store limited to keys under `isolated/<id>/`, the stylesheet changes and the member settings.
- **Pages run in the process.** The extension mounts them on a page host of its own, served by a web handler; the server mounts forwarding routes for them on its page host (`PageHost.mountRoutes`, new in core), forwards each request, event streams included, and drains the process's sessions when another version takes over. Who is signed in comes in the header `x-jellyware-principal`, which the server sets and a browser cannot: the process never holds the sign-in secret (`src/app/auth.ts` reads the header when `JELLYWARE_ISOLATED=1`).
- **The watchdog** (see [one extension can stop the server](#one-extension-can-stop-the-server-fixed-2026-11-25)) and **a process per version** (see [old versions](#old-versions-stay-in-memory-fixed-2026-11-25)).

Tested: a package test starts a real process (its card and commands answered there, a tagged failure arriving as itself, a file outside its folder refused with `ERR_ACCESS_DENIED`, a blocked event loop stopped by the watchdog); both browser checks pass with every extension in its own process (69/69 and 53/53), swaps, session restores, Tailwind classes, unload, settings, secrets, slots and runs included.

Two bugs of the channel were found on the way and fixed: closing a version left streams forwarded to browsers open (now closing one end ends what waits on it, so browsers reconnect to the new version), and a version's last snapshot writes went unanswered while it closed (the channel now runs in a scope of its own, closed last).

- **Costs:** about 80 MB per process (the five in the example take 400 MB) and half a second to start a version. Every change of the workspace is copied to each process that follows it.
- **What is left:** the extensions' own tests run in a test runner on the server, with the server's environment removed but not in the permission model. A process that fails is not started again by itself. Isolation stops reach, not intent: an extension can still misuse the services it is given (see [the first risk](#extensions-run-with-the-apps-rights)).

## Data of extensions (built 2026-11-25)

Extensions kept their data in the app's stores (an issue's priority, a member's role). Now each extension may have a SQLite database of its own (Node's `node:sqlite`; `packages/jellyware/src/data.ts`), kept by the server in `.jellyware/data/<id>.sqlite` across versions, undo and restarts, after bb's per-plugin database:

- **Tables from migrations in extension.json** (`"migrations": ["CREATE TABLE pins (...)"]`): data the review diff shows and the checks can read. They are append-only, as in bb: the statement at index n is migration n, its hash is recorded when applied, and a version must declare the applied ones unchanged and in order before new ones. The loader applies new ones in one transaction before it builds the extension; a changed or failing one stops the load.
- **Checked before a run goes live:** `migrationsCheck` replays a changed extension's migrations on a copy of its database (`VACUUM INTO`, consistent while the server writes; an empty one for a new extension), so "Migration 0 differs from the one applied before … add a new migration after the last one" or a failing statement goes back to the agent like a type error. The browser check runs a scripted change to an applied migration and sees the run fail before anything goes live.
- **Rows through `ExtensionData`:** `query(sql, params)`, `run(sql, params)`, and `changes`, a counter that grows with every write, to follow from a page. SQLite's authorizer keeps the extension's statements to reading and writing rows of its tables: no `CREATE`/`DROP` outside migrations, no `ATTACH` of another file, no `PRAGMA`, no writes to the table of applied migrations. An extension in its own process gets the same service over the channel; the database stays with the server.
- **Shown:** the workshop lists an extension's tables and migrations ("Data: pins (1 migration)"); the agent's guide lists tables with their columns and says how many migrations are applied, so the agent appends instead of editing.

`extensions/pins` is the reference: a card on every issue to pin it for oneself, a page /pinned with the member's pins, a table `pins` from one migration. Tests: the authorizer's refusals, append-only and failing migrations, rows across a new version, the check on a copy (package); pin, read back per member, unpin, and the refused migration change (browser check, 75/75).

- **What is left:** one database per extension, on one server ([one server, one folder](#one-server-one-folder)); several servers want the app's Postgres with a schema per extension. No backup or export of an extension's data, and removing an extension leaves its database. The authorizer and `ATTACH` refusal need Node 24 or later.

## Managing extensions: sections, chat, on and off (built 2026-11-25)

/extensions grew into one long page. It now has a second sidebar with five sections, each at a path of its own, moved between within the session (`onUrlChange`):

- **Extensions** (`/extensions`): each extension with what it adds, its data, its settings and the member's own settings, and the history of settings changes. Administrators turn an extension off and on (`Extensions.setEnabled`): off unloads it and keeps it unloaded across restarts and changes of its files, until it is turned on; its folder, settings and data stay. The loader lists it as `disabled`, and the agent's guide says it is turned off.
- **Chat** (`/extensions/chat/<run>`): conversations with the agent. A run's activity (`Changes.activity(runId)`, kept in the run's `activity.json`) is what the agent said, every tool it called with its file and outcome, and each step of the pipeline: an attempt, each check with its time and its error, a failure sent back, the review, the install, an undo. pi runs in JSON mode (`--mode json`) for it; the agent reports events through `Task.report`. A message in a conversation starts a run that follows up the conversation's newest run (`Run.thread`, `Changes.start(prompt, author, thread)`): pi forks that run's session and is told what became of it (live, rejected, failed), since the stage is a new copy of what is live now. A follow-up waits until the agent is done with the conversation. Runs in review are approved or rejected in the chat.
- **Changes** (`/extensions/changes`): every run with its diff, review and undo, and a link to its conversation.
- **Customize** and **People**: what was on the page before. An example opens a new conversation with it.

Tests: the activity of a run that fails a check once, approval steps, follow-ups and refusals, and turning off and on (package); each section over HTTP, the activity streamed into a conversation, and the update's checks (example); the sections, an extension turned off and on while another person's page shows it, the chat's tool calls, checks and a follow-up, and three attempts of a failing change (browser check, 90/90). A real pi conversation (a "days open" card, then "also show the date it was created") showed each read and write as it happened; the follow-up forked the first session and took 75 seconds.

- **What is left:** a follow-up of a run still in review starts from what is live, so the agent writes that run's change again; continuing the stage of a run in review would be closer to what people expect. Members cannot write in the chat. Tool calls show the file, not the edit; the diff at the end shows what changed.

## Browser code: charts, maps and islands of extensions (built 2026-11-25)

Extension code ran on the server only, so anything that needs the browser (a tooltip under the pointer, panning a map, dragging a card) could not be built. It comes in two kinds, chosen by who writes the browser code.

**Widgets the app ships, for the common cases.** `chart(...)` (`#app/widgets/chart`) and `map(...)` (`#app/widgets/map`) are islands of the app, built by Vite into its islands bundle (`npm run build:islands`), which every page loads. An extension renders them in a page's view from data; it writes no browser code. As bb puts it, the host draws what it can from declarations.

- **The chart:** line, area and bar, stacked or side by side, up to eight series. The dataviz reference palette is used in light and dark (`--series-1` … `--series-8` in `styles.css`). A crosshair and tooltip list every series at the x under the pointer, and the arrow keys move it. The legend hides and shows series (colours stay with their series). A table view, whole-number ticks for counts, and dates as "Nov 3". Clicks come back as Messages (`onClick`), as island events, which update checks like anything a browser posts. The geometry is pure (`chart-geometry.ts`) and tested; the program has Story tests.
- **The map:** crease/ui's MapLibre map with OpenFreeMap tiles, copied from the dispatch example. Places are markers with a tooltip (title and details) on hover and focus. The view fits every place, pans to a selected one, and reports clicks on places or picked locations (`onClickPlace`, `onPick`). The pages' content security policy allows the tile server.
- **In the example:** `extensions/progress` now charts with it (per team, a click on a day lists its tickets), and `extensions/team-map` (new) shows where the team works, from a table of its own, with "Move my marker" picking a location on the map. The island package gained optional event handlers, and a handler that returns null drops an event, so a forged event is not an error.

**An extension's own browser code, for the rest: islands in sandboxed frames.** Item 11 keeps an extension's server code from acting beyond what it is given. Browser code in the page would undo that: it runs as the signed-in person, with their cookie, and can post any event to any page. So an extension's island runs in a frame of its own (`packages/jellyware/src/islands/`):

- **Declared and built per version:** `"islands": { "calendar": "calendar.island.ts" }` in extension.json. The loader bundles each one with esbuild (Effect, Foldkit and what it imports, minified) and keeps the code by its hash. A build error fails the version like any other load error, so it goes back to the agent. The extension reads the frame's address while building, from `ExtensionIslands.src(name)` (a missing name fails the build), and renders `islandView(Contract, { id, src, label, props, onEvent }, h)`.
- **The frame:** `/_jellyware/islands/<id>/<name>/<hash>` serves a small page with the code inline. Its content security policy runs that one script (by nonce) and loads the app's stylesheet. It allows no network: `connect-src 'none'`, no images or fonts from elsewhere, no forms. The host element puts it in `<iframe sandbox="allow-scripts">`, an opaque origin with no cookies, no storage and no access to the page. The browser check probes all four from inside the frame and sees each one refused.
- **Between page and frame:** `postMessage` carries props in, and events, the content's height, and failures out (`contract.ts`, checked on both sides). The host takes messages only from its own frame. It forwards the colour scheme, sizes the frame to its content, and turns events into the same `island-event` the app's islands use, so the page's update gets them as Messages.
- **Failures and new versions:** a new version has a new address, so open pages load the new frame when the page host hands their sessions over; the browser check changes the calendar and sees the change without a page load. A failure in the frame (an uncaught error, or a Foldkit crash, which Foldkit only logs) replaces the frame with a message on the page, and the host reports it. The server logs it and shows it with the extension under Manage extensions until its next version.
- **In the example:** `extensions/activity` draws a calendar of the workspace's activity (hover a day for its changes, click it to list them), which neither widget does.

**For the agent:** its instructions, the guide (which lists each extension's islands) and "Customize" (Charts, Maps, Browser code of its own) say when to use which, with the references. Two real pi runs:

- **A bar chart** of issues created per week, per team, with a click listing a week's issues. It passed every check on the first attempt in 108 seconds, used the chart widget, and worked after approval (tooltip per week).
- **A drag-and-drop board** "Now, Next, Later" with the order in a table of its own. pi wrote it as an island with a contract, a program, tests and a table. It passed the checks on the second attempt in 4½ minutes (the first had a numeric `version` in extension.json).
  - In the browser, its first move crashed the island: it passed a whole Message, `_tag` included, into its event's `make`. Story tests do not run Commands, so its tests missed it. Before the crash reporting above existed, the frame just went blank; finding that is why it exists. The instructions now name the mistake.
  - With that one line fixed, buttons and drag and drop moved cards inside the sandboxed frame, and the order survived a reload.

Tests: chart geometry, the chart and calendar programs (Story); islands built per version, a broken, misnamed or escaping island, the frame's policy and its script that cannot be closed early, the message protocol (package). Browser check 110/110 (charts, maps, the island and its sandbox, a new version, the workshop listing); 316 tests.

- **What is left:**
  - **No shared runtime yet:** each island bundles its own Effect and Foldkit (about 300 KB minified, cached by hash). The shims bb and Powermove use would shrink that, but a sandboxed frame still parses its own copy.
  - **No network for islands:** there is no way to declare a host an island may reach (a map in an island would need its tiles), and a map inside an island cannot fetch its tiles. Use the map widget instead.
  - **Contained:** tooltips stay inside the frame, and a frame cannot reach the page's keyboard shortcuts.
  - **Failures not run back to the agent:** a crash in the browser is shown to administrators, not sent to the agent; no check runs an island in a browser before a run goes live.

## The list

Everything left, by size. Items 1 to 8 were done on 2026-11-24, items 9 to 13 on 2026-11-25, in this order; the sections above describe what each does and what it misses.

### Done

| # | Work | Status |
|---|---|---|
| 1 | **The Codex token only while pi runs.** Delete `auth.json` when pi stops, and at start if a stopped server left one. | Done: [the token risk](#the-codex-access-token-lies-in-the-apps-folder-while-pi-runs) |
| 2 | **Import allow-list in the checks.** Allowed modules and names, no process or network globals, no computed `import()`, no `import.meta`. | Done: [extensions run with the app's rights](#extensions-run-with-the-apps-rights) |
| 3 | **pi writes only in the stage.** A pi extension that checks every tool call. | Done: [the agent can write outside its stage](#the-agent-can-write-outside-its-stage) |
| 4 | **A time limit per slot card.** A slow card shows "Loading…"; the others show. | Done: [one slow card](#one-slow-card-hides-the-others-in-its-slot-fixed) |
| 5 | **Roles and approval.** Runs and settings only for administrators. An approval step between "checked" and "installed" in which a person reads the diff. Commands that name the roles that may run them, checked by the registry before `run`. | Done: [who may change the app](#who-may-change-the-app-roles-and-review-since-2026-11-24), [commands](#commands-trust-the-extension-to-check-rights-roles-since-2026-11-24) |
| 6 | **A generated guide for the agent.** The loaded extensions, their pages, slots, commands and settings, written for pi before each run, as bb's `plugin-commands-skill.ts` does. | Done: [the agent's guide](#the-agents-guide-built-2026-11-24) |
| 7 | **More slots.** Actions on the selected row and entries in the command palette, badges on list rows and board cards, and a list on `/extensions` of everything that can be customized. | Done: [slots and what can be customized](#slots-and-what-can-be-customized-built-2026-11-24) |
| 8 | **Better checks.** The extension's own Story and Scene tests in the checks. The agent declares what it changed, and a mismatch with the diff goes back to it (Powermove). | Done: [better checks](#better-checks-built-2026-11-24) |
| 9 | **More settings.** Secret settings (never sent to a browser, the stage or the agent); settings per member. Per workspace not built (one workspace). | Done: [secret and member settings](#secret-and-member-settings-built-2026-11-25) |
| 10 | **Smoother swaps and runs.** The page host hands each open session from the old version to the new one, so no snapshot is overwritten. Runs work side by side (three in the example) instead of one at a time. | Done: [events during a swap](#events-during-a-swap-fixed-2026-11-25), [runs side by side](#runs-side-by-side-built-2026-11-25) |
| 11 | **A child process per extension**, with a watchdog: bundled, Node's permission model, the app's services over a channel, pages forwarded. | Done: [extensions in their own process](#extensions-in-their-own-process-built-2026-11-25) |
| 12 | **Data and migrations for extensions.** A SQLite database per extension, append-only migrations declared in extension.json and checked on a copy before a run goes live, rows through `ExtensionData`. | Done: [data of extensions](#data-of-extensions-built-2026-11-25) |
| 13 | **Browser code in extensions.** Charts and maps the app ships, and an extension's own islands in sandboxed frames without network, built per version. | Done: [browser code](#browser-code-charts-maps-and-islands-of-extensions-built-2026-11-25) |

### Large

| # | Work | Why | Where it was described |
|---|---|---|---|
| 14 | **Several servers.** Extensions and runs in the shared store (Postgres); a change feed tells every server to load a new version | [One server, one folder](#one-server-one-folder) | above |
