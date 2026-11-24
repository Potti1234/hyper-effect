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
- To add to the app's own pages, use a slot: `issueSidebar(id, context => Stream<SlotContent>)` shows a card under an issue's properties; its buttons (`action(label, command, args)`) run commands registered with `Contributions.command`. The page renders the card from data and runs only actions it shows; the command must decode `args` and check what the member may do. `extensions/related` is the reference.
- Values an administrator should be able to change go into `settings` in `extension.json` (`string`, `number` with `min`/`max`, `boolean`, `select` with `options`; each with `label` and `default`), read while building with `const settings = yield* ExtensionSettings` (`settings.number('max')`). A change of settings builds the extension again; one it fails with is put back. `extensions/related` declares three.
- Extension pages follow the same rules as the app's pages; frame them with `loadShell`, `shellChanges` and `frame`.
- Import the app's modules as `#app/...` (`#app/extensions`, `#app/domain`, `#app/store`, `#app/view/icons`); keep state in stores, not in module variables (a reload imports the folder again).
- Done means: `npm run typecheck` and `npm test` pass, and `node scripts/check-extensions.mjs` passes against `npm start`.
