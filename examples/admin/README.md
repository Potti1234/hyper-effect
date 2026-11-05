# Catalog admin

The second hyper-effect app (experiment 6): a CRUD admin for a product catalog. Where Dispatch shows live collaboration and islands, this one shows the everyday parts of a business app on the server: sign-in and roles, list pages with filters and pagination, forms, uploads and edit conflicts.

```sh
npm run start:admin      # from the repo root: builds CSS, serves http://localhost:3200
npm run check:admin      # needs a running server: two editors and a viewer in Chromium
npm test                 # Story and Scene tests in test/
# from the repo root:
DATABASE_URL=$(bash tools/postgres/start.sh) npm run start:admin   # on Postgres (Docker)
npm run check:admin-nodes  # two processes on one Postgres: live changes, images, conflicts, failover
bash tools/perf/admin-load.sh 200 1 10    # load test (VARIED=1, PG=1)
node examples/admin/scripts/upload-load.mjs --uploads 20 --megabytes 2   # concurrent uploads, against a server with HYPER_METRICS=1
```

| Environment variable | Use |
|---|---|
| `PORT` | Listen port (3200) |
| `DATABASE_URL` | Products, images and session snapshots in Postgres, so several processes can serve the admin |
| `HYPER_NODE` | This process's name in session ids |
| `HYPER_METRICS` | `1`: metrics routes and raised limits, for load tests |
| `HYPER_SNAPSHOT_SECRET` | Seals snapshots |

Sign in as **ada** (editor) or **grace** (viewer). Open two windows to watch changes and conflicts arrive live.

| Path | Program |
|---|---|
| `/products` | `src/app/products/list.ts`: search, category and status filters, sorting, pagination; the query is mirrored into the URL |
| `/products/new`, `/products/:id` | `src/app/products/edit.ts`: form with Schema validation, image upload (picker or drop), save with conflict detection, delete |
| `/login`, `/logout` | `src/app/auth.ts`: demo sign-in with roles; a signed, HttpOnly cookie |
| `/images/:id` | `src/app/catalog/images.ts`: uploaded images, checked by their bytes and served without script |

The store (`src/app/catalog/store.ts`) is in memory with a change feed. With `DATABASE_URL`, `src/app/catalog/postgres.ts` puts the same service on Postgres: every write runs in a transaction with `pg_notify`, each process listens once, edit conflicts are a conditional `UPDATE` on the revision, and a taken SKU is the unique constraint.

## How it is built

- **One program per page.** Each page's Flags load its data and authorize the user: a viewer asking for `/products/new` gets a 404 before any state exists.
- **In-page state in the URL.** Filters and the page number live in the Model. A `ReplaceUrl` Command, forwarded to the browser, mirrors them into the address bar, and Flags read them back on load.
- **Roles are checked twice.** The view hides what a viewer cannot do. `update` refuses it anyway, because the browser could still post those events.
- **Uploads:** the file reaches `update` as a web `File`, a Command stores it, and the Model keeps only a reference (Models are snapshotted as JSON).
- **Conflicts:** a save names the revision the editor started from. If someone saved in between, nothing is overwritten. The editor sees who saved and can take their version. Changes by others are noticed while editing, too.
- **Regions** around the header, toolbar, results (a region per row), pager, form, image panel and conflict notice. A change to one product sends one row.

## Environment

| Variable | Default | Use |
|---|---|---|
| `PORT` | `3200` | Listen port |
| `ADMIN_SECRET` | dev value | Signs the sign-in cookie |
| `HYPER_SNAPSHOT_SECRET` | dev value | Seals session snapshots in `.hyper-sessions/` |
