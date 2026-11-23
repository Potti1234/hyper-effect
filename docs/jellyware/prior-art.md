# How bb and Powermove load and change extensions

The extension systems of two apps that agents change while they run: their anatomy, loading, isolation, UI contribution, agent pipeline and state. Paths are relative to each repository, read at the commits listed in the [README](README.md#sources).

[bb](https://github.com/get-bb/bb) is an agentic IDE whose features are plugins. [Powermove](https://github.com/iterative-computer/powermove) is a video editor with a small kernel; timeline, viewer, inspector and effects are extensions (`apps/desktop/src/renderer/src/kernel/builtins.ts`). In Powermove, paths below are under `apps/desktop/`.

## Anatomy of an extension

| | bb | Powermove |
|---|---|---|
| Unit | An npm package with a `bb` block in `package.json`: `server`, optional `app`, `host`, `skills` (`plugins/tasks/package.json`) | A folder with `manifest.json` and an entry module (`packages/registry/src/manifest.ts`) |
| Entry | `export default (bb: BbPluginApi) => void \| Promise<void>` | `export default (api: PowermoveAPI) => void \| Disposable \| Promise<…>` (`src/renderer/src/kernel/api.ts:1418`) |
| Manifest fields | name, description, icon, entries, SDK version range | `id, version, apiVersion, entry, contributes, replaces, dependsOn, forkedFrom, vars, permissions` |
| What it registers | HTTP and WebSocket routes, typed RPC, realtime channels, background services and schedules, a CLI command, agent tools and instructions, settings, about 40 UI slots | Panels, inspector sections, commands, keybindings, menus, effects, transitions, layer types, themes, status items, named services |

Both APIs are large: bb's `packages/plugin-sdk/src/app-contract.ts` has 6,511 lines, Powermove's `api.ts` 1,426.

## Loading and reloading

Both compile with esbuild and keep shared libraries out of the bundle:

- **bb** replaces `react`, its SDK runtime and UI libraries with stubs that read `globalThis.__bbPluginRuntime` (`packages/plugin-build/src/build-plugin-app.ts:139`). Server code imports of `@get-bb/plugin-sdk` resolve to the host's copy.
- **Powermove** replaces `powermove` and `svelte/*` with shims that read `globalThis.__powermove_runtime` (`src/main/extensions/compiler.ts:117`). Its esbuild plugin also rejects bare, absolute and directory-escaping imports.

Reloading:

- **bb, server side.** A `registerHooks` resolve hook from `node:module` adds `?bbPluginLoad=<id>.<epoch>` to every file URL under the plugin directory (`apps/server/src/services/plugins/plugin-runtime.ts:171-216`). Raising the epoch makes Node import the whole plugin tree again. The new instance is built and its factory run first, with a 30 s limit; only when that succeeds is the old instance disposed and the new registrations applied. On failure the log says "the previous instance is still running" (`plugin-runtime.ts:350`).
- **Powermove.** A recursive file watcher debounces for 300 ms, rebuilds the extension and writes the bundle atomically. The renderer deactivates the extension and imports the bundle again with `?r=<token>`, inside `kernel.panels.batchChanges()` so the layout never shows a panel as missing (`src/renderer/src/kernel/loader.ts:378-546`). All loads go through one queue.

Load order in Powermove comes from a pure function, `planLoad()` (`loader.ts:90`): it drops disabled extensions, applies `replaces`, removes extensions whose `dependsOn` failed, and sorts the rest topologically.

## Cleanup

- **bb** disposes in a fixed order: sockets, the host process, services, `onDispose` hooks in reverse order, in-flight calls, database handles. A call on the old API object afterwards throws `PluginContextStaleError`.
- **Powermove** collects every `Disposable` and releases them in reverse order. Each registry entry also records its owner, so `kernel.disposeOwner(id)` releases what was missed (`src/renderer/src/kernel/registry.ts:145`). A registry keeps a stack per id: registering an existing id shadows the entry, and disposing the shadow brings the previous one back.

An Effect `Scope` per extension covers both: every registration is an `acquireRelease`, and closing the scope releases them in reverse order.

## Isolation and trust

Neither isolates the team's own extensions. Powermove's design document: "We deliberately do not sandbox extensions; error isolation, auto-disable, and one-click revert are the recovery model" (`docs/extensions-design.md`).

| | bb | Powermove |
|---|---|---|
| Local and agent-written code | In the server process and the app's page | In the renderer's main frame |
| Error containment | Errors attributed to a plugin by `AsyncLocalStorage` and stack traces; crashed services restarted with backoff; a React error boundary per slot | Every callback wrapped by `guard()`; two throws within 10 s disable the extension (`loader.ts:407`); 10 s activation timeout |
| Separate process | `host` entries, one forked child per plugin and generation (`apps/host-daemon/src/plugin-host-manager.ts`) | Store extensions, on their own origin with an RPC allow-list, a watchdog and rate limits (`src/renderer/src/kernel/sandbox-host.ts`) |
| Permissions | None | `network`, `clipboard`, `assets`, `project:write`, `full-access`, for store extensions |

## UI contributions

- **bb** has typed slots (`PluginAppSlots`, `app-contract.ts:4013`). Each host location subscribes to one slot kind and renders the registered components, keyed by plugin, id and generation so a new generation mounts fresh. Where it can, bb draws UI itself from declarations: tool rows declare a label, icon and tint; `ui.requestInput` forms are rendered by bb. Its provider document states the rule: "Every client renders everything without plugin code. Plugin renderers are a web upgrade" (`docs/provider-plugin-api.md`).
- **Powermove** registers panels by id; the saved layout stores ids, so a reloaded or replacing panel appears in the same place. Inspector sections, menus (`menus.contribute(location, ctx => items)`), status items and palette providers are further contribution points. Extensions reach each other through named services, also stacked per name, so an extension can wrap another's service.

## Agent pipeline

**bb** has no dedicated pipeline. "New plugin" opens an agent thread with a prompt and an authoring skill (`plugins/bb-guide/skills/bb-plugin-authoring/SKILL.md`). The agent uses `bb plugin new | build | install | dev | reload`. The host enforces the manifest schema, a successful build and a successful factory run; type checks and tests are left to the skill. A generated skill lists every plugin's commands for agents (`apps/server/src/services/plugins/plugin-commands-skill.ts`). Updates from git or npm are snapshotted (database, settings, schedules, files), activated, watched for errors during a stabilization window and rolled back on failure (`apps/server/src/services/plugins/plugin-activation.ts`). Local edits have no undo besides git.

**Powermove** treats extension code as part of the undoable state:

1. The agent edits a staging copy (`prepareExtensionStage`, `src/main/codex/change-history.ts:51`).
2. When it finishes, the stage is copied into a folder the agent process cannot write, so what is validated is what is installed.
3. Validation parses the manifest, scans for credentials and compiles with the real compiler (`src/main/codex/validate-staged-extensions.ts`).
4. `publishExtensionChanges` (`change-history.ts:112`) requires the agent's declared list of changed extensions to match the hash difference. On a mismatch, nothing is applied and the agent is asked again, at most twice. It refuses if the live files changed since the stage was made.
5. The swap writes `before/` and `next/` into a pending folder and renames; an interrupted swap is rolled back at start.
6. After loading, a check runs against the live app and its report goes back to the agent, for at most three runs.
7. Each run returns a change set. Restoring it puts back the `before/` trees only if the live tree still has the hash the run produced (`afterRootHash`); otherwise later change sets must be restored first.

Project edits by the agent go through a closed set of 27 edit commands with a `baseRevision` check; one agent run is one undo entry.

## State

- **bb:** per-plugin key-value rows, a SQLite file per plugin and a files directory. Migrations are append-only; each statement's index is its id and its hash is recorded, so an edited or reordered migration is rejected (`packages/plugin-sdk/src/internal/host-policy.ts`). State survives a reload because it lives outside the module.
- **Powermove:** the project document holds data, never code; an extension's layer stores a definition id, version and JSON data. Effects keep old definitions so a saved instance renders with the version it was made with. No migration hook for extension data exists.

## What to take

| From | Take |
|---|---|
| bb | The resolve hook that re-imports a whole extension tree; building the new version before disposing the old; shared libraries from the host; a generated skill listing extensions for the agent; append-only hashed migrations; declarative UI drawn by the host |
| Powermove | A registry with a stack per id and owner tags; disable after repeated failures; staging, immutable snapshot, declared-versus-actual diff, journaled swap; change sets undone by hash |

| Avoid | Seen in |
|---|---|
| An API surface of thousands of lines with `experimental_` and retired names | bb `app-contract.ts` |
| Failure handling that differs between server and browser: the browser drops the old generation when a new bundle fails to import | bb `apps/app/src/lib/plugin-frontend.ts:871` |
| Undo orchestration in a large untyped file | Powermove `src/renderer/src/legacy/assistant/spatial.ts`, about 3,700 lines |
| No migrations for extension data | Powermove |
