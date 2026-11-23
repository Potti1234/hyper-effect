# Jellyware example

The Linear clone of `apps/linear-clone` with extensions: folders in `extensions/` that add pages and sidebar entries, loaded, swapped and unloaded while the server runs. It is the first app of `@hyper-effect/jellyware`; the design is in [docs/jellyware](../../docs/jellyware/README.md). Not released.

```sh
npm run build                                  # CSS
node --import tsx src/main.ts                  # http://localhost:4200 (npm run dev restarts on changes to src/, not extensions/)
npm test                                       # Story tests of update, HTTP tests of the pages
npm run typecheck
node scripts/check.mjs                         # the Linear clone's browser check (two people in Chromium)
node scripts/check-extensions.mjs              # extensions: entry, page, swap while open, unload and reload
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

Limits of this version: Tailwind classes used only by an extension need `npm run build` and a page reload; old module versions stay in memory until the server restarts; extensions run in the server process with the app's rights.

| File | What it is |
|---|---|
| `src/main.ts` | The server: page layers, sign-in routes, static files, services, snapshot store, the page host and the extension loader |
| `src/app/extensions.ts` | What the app offers extensions, and the shell for their pages |
| `extensions/standup/` | The Stand-up extension: per member, the issues in progress and in review |
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
