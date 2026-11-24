# Working on Linear

This is a hyper-effect app. Before changing it, load the `hyper-effect` skill (and the `foldkit` skill for Foldkit itself); they explain the architecture, the rules and where to find working references.

- Pages are Foldkit programs whose update loop runs on the server. Keep update and view pure; side effects are Commands.
- Only Messages listed in a page's `ClientMessage` may be bound in its view; typed text goes through `onInput`/`onChange` handlers. Re-check permissions in update.
- Wrap independently changing parts of a page in `region(h, { id, deps, render })` and list every Model field the region reads in `deps`.
- Commands run on the server: no `window`, `document` or `localStorage`.
- Done means: `npm run typecheck`, `npm test` and `npm run check` (against `npm start`) pass.

## Extensions

Users change this app by adding or editing folders in `extensions/`; the running server loads each change.

- An extension is `extensions/<id>/extension.json` (`id` equal to the folder name, `name`, `version`, `entry`) and an entry module whose default export is `extension(Layer...)` from `src/app/extensions.ts`. `extensions/standup` is the reference.
- It may use only the services in `requires` (`src/app/extensions.ts`); register pages with `PageHost.mount(program, { ...pageOptions, path })` and sidebar entries with `Contributions.nav`. Everything it registers belongs to its layer's scope.
- To add to the app's own pages, use a slot (`CUSTOMIZATIONS` in `src/app/extensions.ts` lists them, and /extensions shows them under "What you can customize"): `issueSidebar(id, context => Stream<SlotContent>)` shows a card under an issue's properties, `issuesPalette(id, context => Stream<SlotContent>)` adds entries to the issue lists' command palette (actions for the selected issue, links), and `issueBadges(id, Stream<Badge[]>)` shows badges on issue rows and board cards. Buttons and palette actions (`action(label, command, args)`) run commands registered with `Contributions.command`. The page renders the card from data and runs only actions it shows; the command must decode `args` and check what the member may do. A command only administrators should run names `roles: ['admin']`: the registry checks the member's role before `run` and leaves the button out for members (`rolesOf` in `src/app/extensions.ts`). `extensions/related` (card, palette action), `extensions/standup` (palette link) and `extensions/stale` (badges) are references. A new slot goes into `CUSTOMIZATIONS` too, so people and the agent find it.
- Values an administrator should be able to change go into `settings` in `extension.json` (`string`, `number` with `min`/`max`, `boolean`, `select` with `options`; each with `label` and `default`), read while building with `const settings = yield* ExtensionSettings` (`settings.number('max')`). A change of settings builds the extension again; one it fails with is put back. `extensions/related` declares three.
- Extension pages follow the same rules as the app's pages; frame them with `loadShell`, `shellChanges` and `frame`.
- Extensions bring their own tests, `extensions/<id>/*.test.ts` (Story for a page's update, Scene for its view, assertions for pure functions; data from `#app/seed`). `npm test` runs them, and a change by prompt goes live only if the tests of every extension it changed pass. `extensions/standup/page.test.ts`, `extensions/stale/extension.test.ts` and `extensions/related/extension.test.ts` are references.
- Import the app's modules as `#app/...` (`#app/extensions`, `#app/domain`, `#app/store`, `#app/view/icons`); keep state in stores, not in module variables (a reload imports the folder again).
- Extensions run inside the server: a change by prompt goes live only if its imports follow `src/app/extension-rules.ts` (Effect's root module, Foldkit, named parts of `@hyper-effect/core` and `@hyper-effect/jellyware`, the `#app` modules above, the extension's own files) and it uses no `process`, `globalThis`, `require`, `eval`, `Function`, `fetch`, `import.meta`, computed `import()` or Effect's `Config`. `test/extension-rules.test.ts` checks every extension in the folder.
- Done means: `npm run typecheck` and `npm test` pass, and `node scripts/check-extensions.mjs` passes against `npm start`.
