# Where the extension system lives

Three places for the extension system (in `@hyper-effect/core`, as a package in this repository, or in a separate repository), what each costs, and the decision.

## Decided (2026-11-23)

- The proposal below: the page host in core, the extension system in `packages/jellyware`, the agent pipeline first in the example app.
- The first app is `examples/jellyware`, based on `apps/linear-clone`, with a sidebar entry and page contributed by an extension. The prompting UI follows later.
- The work stays on the local branch `jellyware`: not pushed, no changesets, not released.
- The agent is pi, signed in with the Codex `auth.json`.
- The pipeline turned out not to depend on the agent, so it is in `packages/jellyware` (`Changes`); only the pi agent and the typecheck are in the example app.

## What has to change in core in any case

The page host, the split of `Hyper.layer` and the stylesheet reload ([design.md](design.md#changes-to-hyper-effectcore)) are changes to `packages/core/src/server.ts`. They belong in core wherever the rest goes: a separate project cannot add routes that can be removed without them, and they are useful without extensions (modules switched on per tenant or by an administrator).

The question is where the rest goes: the Graft dependency, the loader, the contributions registry, slots and commands, the agent pipeline and change sets.

## The options

**A. In `@hyper-effect/core`.** Extensions become a feature of the framework.

**B. A package in this repository**, such as `packages/jellyware` published as `@hyper-effect/jellyware`, with an example app `examples/jellyware`. This is how `@hyper-effect/island` is set up today: its own package, versioned with changesets next to core.

**C. A separate repository** that depends on published releases of `@hyper-effect/core`, as an app depends on it.

## Comparison

| | A. In core | B. Package in this repository | C. Separate repository |
|---|---|---|---|
| Changing core and the extension system together | One commit | One commit | A core release first, then the other repository |
| Dependencies for apps without extensions | Graft and the loader in every app | None | None |
| Core's API | Grows by registry, slots, loader | Unchanged except the page host | Unchanged except the page host |
| Tested against the example apps and `npm run check:*` | Yes | Yes | Needs its own example app and checks |
| Exposure to Graft's API changes | Core | One package | One repository |
| Own release cycle and owners | No | Partly: own version, same repository | Yes |
| Agent pipeline (stage, validate, swap, undo) | Does not fit a page framework | Fits as a second package or in the example app | Fits |

Core is published at 0.1.2, where a minor release may still change the API, and the page host is a new API. While it settles, the page host and the extension system will change together, which favours one repository.

## Proposal

1. **Core** gets the page host, the `pageRoutes` split and the stylesheet reload, with HTTP tests. No Graft dependency.
2. **`packages/jellyware`** (`@hyper-effect/jellyware`) holds the Graft wrapper, the loader, the contributions registry, slots and commands. It depends on core.
3. **The agent pipeline** starts inside `examples/jellyware`: how an agent is started (Claude Agent SDK, Claude Code CLI) is the app's choice. It moves into a package once a second app needs it.
4. **Moving to a separate repository** is worth reconsidering when core's API is frozen and the extension system has its own users or release pace.

