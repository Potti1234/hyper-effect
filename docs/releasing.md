# Releasing

Three packages are published to npm, always together and at the same version:

| Package | What it is |
| --- | --- |
| `@hyper-effect/core` | the server: pages, sessions, regions, bindings, stores |
| `@hyper-effect/island` | Foldkit islands for hyper-effect pages |
| `create-hyper-effect` | `npm create hyper-effect@alpha <name>` |

Everything else in the repository (apps, examples, the root) is private and never published.

## How a release happens

1. **Every PR that changes a published package adds a changeset:** `npx changeset`, pick patch/minor, write one line for the changelog. The file goes in `.changeset/` with the PR.
2. **On `main`, the Release workflow** (`.github/workflows/release.yml`) opens or updates a **Version Packages** PR. That PR bumps the three versions, writes the `CHANGELOG.md` files and deletes the consumed changesets.
3. **Merging the Version Packages PR publishes.** The workflow runs `npm run release`:
   - `tools/build/pack.mjs` compiles core and island, stages each package as it is published (exports on `dist/*.js` and `dist/*.d.ts`, no `private`, workspace dependencies pinned to the exact version, the agent skill inside `create-hyper-effect`) and checks every entry point imports under plain node;
   - `tools/build/publish.mjs` publishes the staged directories in dependency order with provenance, skips versions already on npm, and puts prereleases on the `alpha` dist-tag;
   - changesets/action then pushes the tags (from the `CHANGESETS_OUTPUT` events `publish.mjs` writes) and creates the GitHub releases.

In the workspace, `package.json` exports keep pointing at `src/*.ts` and the packages stay `"private": true`. That keeps tsx, Vite and Vitest on the source, and makes a stray `npm publish` from a package directory fail.

## Before 0.1: alpha prereleases

The repository is in changesets **pre mode** with the tag `alpha` (`.changeset/pre.json`). Version Packages PRs produce `0.1.0-alpha.0`, `0.1.0-alpha.1`, … published on the `alpha` dist-tag. So `npm install @hyper-effect/core@alpha` and `npm create hyper-effect@alpha` get the newest one.

npm also pointed `latest` at `0.1.0-alpha.0`, because a package's first publish always sets `latest`. Later alphas do not move it, so a plain `npm install @hyper-effect/core` keeps getting `0.1.0-alpha.0` until `0.1.0`. To move it by hand (from an npm account with publish rights): `npm dist-tag add @hyper-effect/core@<version> latest`, and the same for the other two packages.

For 0.1.0 itself: `npx changeset pre exit` in a PR; the next Version Packages PR produces `0.1.0` on `latest`.

Core deep-imports Foldkit's serializer and uses Foldkit's experimental server API, so its peer range covers one Foldkit minor (`~0.170.0`). Each Foldkit minor needs a hyper-effect release; the weekly Latest Foldkit workflow says when one breaks.

## Checks

| Command | What it checks |
| --- | --- |
| `npm run check:pack` | build, stage, import every entry point under node, `npm pack` (in CI) |
| `npm run check:create` | after `check:pack`: creates an app from the packed tarballs in an empty directory outside the monorepo, installs it, typechecks, tests and builds its CSS (in CI) |
| `node tools/build/publish.mjs --dry-run` | after `check:pack` on a versioned tree: what `npm publish` would upload |

## npm setup

Done once, and kept here for reference:

- the `hyper-effect` npm organization owns the three packages;
- GitHub repository Settings → Actions → General → Workflow permissions allows GitHub Actions to create and approve pull requests (the Version Packages PR);
- `0.1.0-alpha.0` was published with a temporary npm token, because npm trusted publishing can only be configured on a package that already exists; the token is revoked and the `NPM_TOKEN` secret deleted;
- each package has a trusted publisher (npmjs.com → the package → Settings → Trusted Publisher): GitHub Actions, user `Potti1234`, repository `hyper-effect`, workflow `release.yml`, no environment; publishing access is "Require two-factor authentication and disallow tokens".

So the Release workflow publishes with OIDC and stores no npm token. A publish that fails with `E404` or `ENEEDAUTH` usually means a trusted publisher setting does not match the workflow.

If the repository moves to the `hyper-effect` GitHub organization, update the trusted publishers, the `repo` in `.changeset/config.json` and the `repository` fields in the three `package.json` files.
