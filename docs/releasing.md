# Releasing

Three packages are published to npm, always together and at the same version:

| Package | What it is |
| --- | --- |
| `@hyper-effect/core` | the server: pages, sessions, regions, bindings, stores |
| `@hyper-effect/island` | Foldkit islands for hyper-effect pages |
| `create-hyper-effect` | `npm create hyper-effect@latest <name>` |

Everything else in the repository (apps, examples, the root) is private and never published.

## How a release happens

1. **Every PR that changes a published package adds a changeset:** `npx changeset`, pick patch/minor, write one line for the changelog. The file goes in `.changeset/` with the PR.
2. **On `main`, the Release workflow** (`.github/workflows/release.yml`) opens or updates a **Version Packages** PR. That PR bumps the three versions, writes the `CHANGELOG.md` files and deletes the consumed changesets.
3. **Merging the Version Packages PR publishes.** The workflow runs `npm run release`:
   - `tools/build/pack.mjs` compiles core and island, stages each package as it is published (exports on `dist/*.js` and `dist/*.d.ts`, no `private`, workspace dependencies pinned to the exact version, the agent skill inside `create-hyper-effect`) and checks every entry point imports under plain node;
   - `tools/build/publish.mjs` publishes the staged directories in dependency order with provenance, skips versions already on npm, and puts prereleases on the `alpha` dist-tag;
   - changesets then tags the commit and creates the GitHub releases.

In the workspace, `package.json` exports keep pointing at `src/*.ts` and the packages stay `"private": true`. That keeps tsx, Vite and Vitest on the source, and makes a stray `npm publish` from a package directory fail.

## Before 0.1: alpha prereleases

The repository is in changesets **pre mode** with the tag `alpha` (`.changeset/pre.json`). Version Packages PRs produce `0.1.0-alpha.0`, `0.1.0-alpha.1`, … published on the `alpha` dist-tag. So `npm install @hyper-effect/core@alpha` and `npm create hyper-effect@alpha` get them; nothing is `latest` yet.

For 0.1.0 itself: `npx changeset pre exit` in a PR; the next Version Packages PR produces `0.1.0` on `latest`.

Core deep-imports Foldkit's serializer and uses Foldkit's experimental server API, so its peer range covers one Foldkit minor (`~0.170.0`). Each Foldkit minor needs a hyper-effect release; the weekly Latest Foldkit workflow says when one breaks.

## Checks

| Command | What it checks |
| --- | --- |
| `npm run check:pack` | build, stage, import every entry point under node, `npm pack` (in CI) |
| `npm run check:create` | after `check:pack`: creates an app from the packed tarballs in an empty directory outside the monorepo, installs it, typechecks, tests and builds its CSS (in CI) |
| `node tools/build/publish.mjs --dry-run` | after `check:pack` on a versioned tree: what `npm publish` would upload |

## One-time npm setup

The `hyper-effect` npm organization exists. npm trusted publishing (OIDC from GitHub Actions, no stored token) can only be configured on a package that already exists, so the first release uses a token once.

1. **Allow the workflow to open PRs:** GitHub, repository Settings → Actions → General → Workflow permissions → tick "Allow GitHub Actions to create and approve pull requests".
2. **Create a temporary token:** npmjs.com → Access Tokens → Generate New Token → Granular Access Token. Packages and scopes: Read and write, All packages (a token limited to named packages cannot create a new one). Organizations: none. Tick "Bypass two-factor authentication". Expiration: 7 days.
3. **Store it** as the repository secret `NPM_TOKEN` (Settings → Secrets and variables → Actions).
4. **Release `0.1.0-alpha.0`:** merge the PR that adds this file; the Release workflow opens "Version Packages"; merge that.
5. **Switch to trusted publishing**, for each of `@hyper-effect/core`, `@hyper-effect/island` and `create-hyper-effect`: npmjs.com → the package → Settings → Trusted Publisher → GitHub Actions, organization or user `Potti1234`, repository `hyper-effect`, workflow filename `release.yml`, no environment. Then, under Publishing access, choose "Require two-factor authentication and disallow tokens".
6. **Delete** the `NPM_TOKEN` secret and revoke the token on npmjs.com.

If the repository moves to the `hyper-effect` GitHub organization, update the trusted publishers, the `repo` in `.changeset/config.json` and the `repository` fields in the three `package.json` files.
