# Jellyware example

The Linear clone of `apps/linear-clone` with extensions: folders in `extensions/` that add pages and sidebar entries, loaded, swapped and unloaded while the server runs. It is the first app of `@hyper-effect/jellyware`; the design is in [docs/jellyware](../../docs/jellyware/README.md). Not released.

```sh
npm run build                                  # CSS
node --import tsx src/main.ts                  # http://localhost:4200 (npm run dev restarts on changes to src/, not extensions/)
npm test                                       # Story tests of update, HTTP tests of the pages
npm run typecheck
node scripts/check.mjs                         # the Linear clone's browser check (two people in Chromium)
node scripts/check-extensions.mjs              # extensions: entry, page, swap while open, unload and reload
JELLYWARE_AGENT=script node --import tsx src/main.ts   # with a scripted agent; then check-extensions also checks prompts and undo
```

Sign in with any name (Ada, Grace, Linus, Margaret, Alan and Katherine are seeded members). The sidebar shows "Extensions → Stand-up", added by `extensions/standup`.

## Extensions

An extension is a folder `extensions/<id>/` with an `extension.json` and an entry module whose default export is a Layer:

```ts
// extensions/standup/extension.ts
export default extension(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const pages = yield* PageHost
      yield* pages.mount(Standup.program, { ...pageOptions, path: Standup.PATH })
      const contributions = yield* Contributions
      yield* contributions.nav({ id: 'standup', label: 'Stand-up', href: Standup.PATH, icon: 'coffee' })
    }),
  ),
)
```

- **What it may use** is `requires` in `src/app/extensions.ts`: the page host, the sidebar entries, the workspace, viewers and the snapshot store. `extension(...)` checks the layer against that list at compile time.
- **Pages** are ordinary hyper-effect programs. `src/app/extensions.ts` has the app's shell for them: `loadShell` in flags, `shellChanges` as a Subscription, `frame` around the view.
- **Changing a file** in the folder loads the extension again (300 ms after the last change): the new version is mounted next to the old one and replaces its page and entries; open pages reconnect and keep their state. A version that fails to import or to build is dropped, and the old one keeps running; the server log says why.
- **Removing the folder** removes the extension's pages and entries from open pages.
- **Settings:** declared under `settings` in `extension.json` and read while building as `ExtensionSettings` (`settings.number('max')`). On `/extensions` every signed-in member can change them ("Settings" next to the extension); the extension is loaded again with the new values. When it fails with them, they are put back and the running version stays; applied changes can be undone. `extensions/related` has three.
- **Cards in the app's pages:** `issueSidebar(id, context => stream)` shows a card under an issue's properties; its buttons run commands the extension registers with `Contributions.command`. The page renders the card from data and runs only actions it shows.

## Changing the app by prompt

`/extensions` ("Manage extensions" in the sidebar) takes a prompt. The agent, [pi](https://github.com/badlogic/pi-mono), works on a copy of `extensions/` in `.jellyware/runs/<id>/`; the app checks the result (manifests, a credential scan, a typecheck), installs it, loads it, and sends failures back to pi up to three times. Each run shows its state, the extensions it changed, pi's summary and any error; an installed run can be undone while nothing newer changed the same extensions. Runs are kept in `.jellyware/runs/`.

pi signs in with the Codex CLI's login: before each attempt the current ChatGPT access token from `~/.codex/auth.json` is copied to `.jellyware/pi-agent/auth.json` without a refresh token, so pi never rotates the Codex CLI's token. A run starts only while that token has an hour left; running `codex` refreshes it. pi must be installed globally (`npm install -g @earendil-works/pi-coding-agent`).

| Variable | Default | Use |
|---|---|---|
| `JELLYWARE_MODEL` | `gpt-6.1-sol` | pi's model (`pi --list-models openai-codex`) |
| `JELLYWARE_THINKING` | `medium` | pi's thinking level |
| `JELLYWARE_PI_CLI` | found through `npm root -g` | pi's `cli.js` |
| `JELLYWARE_AGENT` | pi | `script` for a scripted agent (`replace <file> :: <old> => <new>`) |
| `CODEX_HOME` | `~/.codex` | Where the Codex CLI's login is |

When extension files change, the CSS is built again and open pages load it (`src/app/styles.ts`).

Limits of this version: old module versions stay in memory until the server restarts; extensions run in the server process with the app's rights.

| File | What it is |
|---|---|
| `src/main.ts` | The server: page layers, sign-in routes, static files, services, snapshot store, the page host and the extension loader |
| `src/app/extensions.ts` | What the app offers extensions, and the shell for their pages |
| `src/app/workshop/page.ts` | `/extensions`: prompts, runs with undo, loaded extensions |
| `src/app/agent.ts` | The pi agent with the Codex login, the scripted agent, the typecheck |
| `extensions/standup/` | The Stand-up extension: per member, the issues in progress and in review |
| `extensions/related/` | A card on each issue page (slot `issue.sidebar`): open issues sharing a label, and "Mark urgent" |
| `src/app/issues/page.ts` | List and board (mounted at `/team/:team`, `/my-issues`, `/issues`) |
| `src/app/issue/page.ts` | The issue page `/issue/:identifier` |
| `src/app/store.ts` | The workspace with a change feed, and who views which issue |
| `src/app/domain.ts`, `seed.ts` | Schemas, validation, the URL query, seed data |
| `src/app/view/*` | Shell (sidebar, with the extensions' entries), picker, icons, property items |
| `src/app/shortcuts/contract.ts` | The keyboard shortcuts, shared by both pages |
| `src/ui`, `src/lib` | crease/ui components copied in |
| `test/`, `scripts/` | Tests and browser checks |

## Environment

| Variable | Default | Use |
|---|---|---|
| `PORT` | `4200` | Listen port |
| `APP_SECRET` | dev value | Signs the sign-in cookie |
| `HYPER_SNAPSHOT_SECRET` | dev value | Seals session snapshots in `.hyper-sessions/` |
| `JELLYWARE_WATCH` | on | `0` turns off reloading extensions when their files change |
