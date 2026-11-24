# Risks and open work

What can go wrong with the extension system as built on the branch `jellyware` (2026-11-24), what limits each risk today, and what would remove it; then the design for extension settings, and the other work left for later.

## Risks

### Extensions run with the app's rights

Extension code runs in the server process. `requires` (`examples/jellyware/src/app/extensions.ts`) limits the services an extension's layer is typed against, not what its code can do at run time: a module can import `node:fs`, `node:child_process` or `process.env` and read the app's secrets (`APP_SECRET`, `HYPER_SNAPSHOT_SECRET`), its database, or the files of the machine.

- **Limits today:** extensions are written by the team's agent, which has no shell; every run is typechecked, scanned for credentials, and can be undone.
- **Next step:** reject imports other than `effect`, `foldkit`, `@hyper-effect/*`, `#app/*` and the extension's own files during the checks. A static check of import specifiers; it stops the obvious cases, not `eval` or dynamic `import()` of a computed string, so add a scan for those.
- **Removes it:** run each extension in a child process (`graft/node`, [design.md](design.md#8-trust)); it then gets only the services served to it.

### Anyone signed in can change the app

In the example, every signed-in member can start a run on `/extensions` and undo runs. A prompt can ask for code that reads data the member may not see, or that sends it elsewhere.

- **Limits today:** the example has no roles; it is a local demo.
- **Removes it:** runs only for a role (administrators), and an approval step between "checked" and "installed" in which a person reads the diff of the snapshot.

### The agent can write outside its stage

pi works in the stage with file tools only (read, edit, write, grep, find, ls). Nothing stops those tools from writing to another path, such as another repository or the user's home folder. The pipeline notices only changes to the app's `src/` (hashed before and after) and to live extensions (refused at install).

- **Removes it:** a pi permission extension that refuses writes outside the stage (pi's extension API lets an extension confirm or refuse tool calls), or pi in a container with only the stage mounted writable.

### The Codex access token lies in the app's folder

Before each attempt the agent copies the Codex CLI's ChatGPT access token to `.jellyware/pi-agent/auth.json`. The file is ignored by git, but readable by anyone with access to the folder; the token is valid for about ten days. On Windows the `0600` file mode is not applied.

- **Removes it:** write the file into the run's folder and delete it when pi stops. pi's credential commands (a key starting with `!` in its `auth.json`) are documented for API keys; whether they work for the `openai-codex` OAuth credential is not checked.

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

### One slow card hides the others in its slot

A slot shows once every card in it has content (`Stream.zipLatestAll`); a card whose stream never emits keeps the whole slot empty. On the issue page the first render waits 300 ms for the cards, then the Subscription fills them in.

- **Removes it:** a timeout per card, after which the card shows "Loading" and the others show.

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

## Later: settings for extensions

An extension's settings are values an administrator changes while the app runs, such as how many related issues to show or which team a page is for. This is the part of Graft not used yet: a publication.

- **Declared in the manifest.** `extension.json` gets `settings`, a map from key to `{ type: 'string' | 'number' | 'boolean' | 'select', label, default, options?, secret? }`. The loader decodes it with a Schema.
- **Stored in the app's store.** Values live under `jellyware/settings/<extension>/<key>` (the `KeyValueStore` the app already has), so they survive restarts and new versions of the extension.
- **Given to the extension through Graft.** The loader publishes each extension's values with `Graft.publish(Settings(<id>), values)`; the extension requires its `Settings` key. Changing a value calls `publication.set`, and Graft rebuilds the extension with the new values, its pages and cards included; open pages reconnect as on a swap.
- **Edited on `/extensions`.** A form per extension, built from the manifest: text, number, checkbox, select. Saving validates against the declared types.
- **Secrets.** Values marked `secret` never go to a browser, are not copied into a run's stage, and are not shown to the agent; the form shows only whether one is set.
- **Changes to the declaration.** A new key gets its default; a key that is gone is kept in the store but no longer published; a value whose type no longer fits falls back to the default and shows a warning.
- **Later still:** settings per workspace or per member with Graft's realms (`isolate: [[Settings(<id>), '<workspace>']]`).

Open questions: whether a change of settings is a run (with undo), and who may change them.

## Later: other work

| Work | Why | Where it was described |
|---|---|---|
| Roles and approval for runs | See "Anyone signed in can change the app" | above |
| Import allow-list in the checks | See "Extensions run with the app's rights" | above |
| Child process per extension | Isolation, memory, blocked event loop | [design.md](design.md#8-trust) |
| A generated skill for the agent | Lists the loaded extensions, slots and commands, as bb's `plugin-commands-skill.ts` does | [prior-art.md](prior-art.md#agent-pipeline) |
| The extension's own tests in the checks | Story and Scene tests of an extension's pages | [design.md](design.md#6-the-agent-pipeline) |
| Declared changes compared with the diff | The agent names what it changed; a mismatch is sent back (Powermove) | [prior-art.md](prior-art.md#agent-pipeline) |
| More slots | The issue list (actions on selected rows), the command palette, the board | [design.md](design.md#4-slots-in-existing-pages) |
| Data and migrations for extensions | Tables of their own with append-only migrations (bb) | [design.md](design.md#7-data-and-migrations) |
| Browser code in extensions | Islands built with Vite, with shared runtime shims (bb, Powermove) | [design.md](design.md#5-stylesheets) |
| Runs side by side | Runs go one at a time; a long run blocks the next | `packages/jellyware/src/changes.ts` |
| Session hand-over on swap | See "Events during a swap" | above |
