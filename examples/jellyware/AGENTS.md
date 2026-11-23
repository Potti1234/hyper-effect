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
- Extension pages follow the same rules as the app's pages; frame them with `loadShell`, `shellChanges` and `frame`.
- Import the app's modules with relative paths (`../../src/app/...`); keep state in stores, not in module variables (a reload imports the folder again).
- Done means: `npm run typecheck` and `npm test` pass, and `node scripts/check-extensions.mjs` passes against `npm start`.
