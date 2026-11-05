# {{title}}

A hyper-effect app: Foldkit programs whose loop runs on the server, on Effect, with Datastar in the browser.

```sh
npm start          # builds the CSS, serves http://localhost:4000
npm run dev        # the same, restarting on changes
npm test           # update (Foldkit Story) and the page over HTTP
npm run typecheck
npm run check      # two people in Chromium against the running server
```

Sign in with any name. Open a second window with another name to watch changes arrive live. Press `N` to jump to the new-task field.

| File | What it is |
|---|---|
| `src/main.ts` | The server: the page's layer, sign-in routes, services, snapshot store |
| `src/app/tasks/page.ts` | The page: Model, Message, update, view, Commands, Subscription |
| `src/app/tasks/store.ts` | Shared state with a change feed (in memory; a database in a real app) |
| `src/app/auth.ts` | Demo sign-in with a signed cookie |
| `src/ui`, `src/lib` | crease/ui components (button, input, card); copy more from crease |
| `test/tasks.test.ts` | Story tests of update, HTTP tests of the page |
| `scripts/check.mjs` | The browser check |

## Adding a page

1. Create `src/app/<page>/page.ts` with `Model`, `Message`, `ClientMessage`, `update`, `view` and `program`, like `src/app/tasks/page.ts`.
2. Mount it in `src/main.ts`: `Hyper.layer(Page.program, { ...page, path: '/things/:id' })`.
3. Add Story tests for update and a step to `scripts/check.mjs`.

## Environment

| Variable | Default | Use |
|---|---|---|
| `PORT` | `4000` | Listen port |
| `APP_SECRET` | dev value | Signs the sign-in cookie |
| `HYPER_SNAPSHOT_SECRET` | dev value | Seals session snapshots in `.hyper-sessions/` |

Set both secrets outside development.
