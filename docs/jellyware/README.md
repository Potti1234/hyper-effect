# Jellyware for hyper-effect

Research and design notes for an extension system that lets users change a running hyper-effect app by prompting an agent. Status as of 2026-11-23: the page host is in core, the loader in `packages/jellyware`, and `examples/jellyware` runs an extension that is swapped while pages are open ([design.md](design.md#verified-in-the-example-2026-11-23)). Prompts on its `/extensions` page go through the change pipeline to pi and can be undone ([design.md](design.md#what-is-built-2026-11-23)). Extensions add pages, sidebar entries, and cards with actions in the issue page ([design.md](design.md#4-slots-in-existing-pages)), and have settings that are changed on `/extensions`, put back when the extension fails with them, and undone ([open-work.md](open-work.md#settings-for-extensions-built-2026-11-24)). Risks and what is left: [open-work.md](open-work.md).

## What jellyware means here

A user describes a change in words. An agent writes or edits an extension. The running app validates the extension, loads it without a restart, and shows it to open pages through the usual Datastar morphs. Every change can be undone.

Scope of a first version:

- **In:** server-rendered pages, navigation entries, declarative contributions to slots in existing pages, commands, stores and settings, written by the team's own agent and trusted.
- **Out:** browser code (islands), extensions from strangers, extensions that run in another process.

## Documents

| File | Content |
|---|---|
| [graft.md](graft.md) | What Graft 0.7.0 is, which parts fit, what it leaves open, risks |
| [prior-art.md](prior-art.md) | How bb and Powermove load, isolate, validate and undo extensions |
| [design.md](design.md) | The proposed architecture: eight parts, the changes to `@hyper-effect/core`, open questions |
| [placement.md](placement.md) | Whether the extension system belongs in hyper-effect or in its own project |
| [open-work.md](open-work.md) | The risks of what is built, extension settings (built) and their risks, and the work left for later |

## Findings

- **Graft covers the lifecycle.** Mounting, dependencies between extensions, failure with retry, ordered teardown, settings and a live view of what is mounted. It does not load code: version 0.7.0 removed its loader, hot reload and plugin framework ([graft.md](graft.md)).
- **hyper-effect's router cannot remove routes.** Effect's `HttpRouter` accepts routes added after the server starts, but has no removal, and re-adding a path throws. Mounting a page as an extension needs a route host in core that registers fixed routes once and dispatches to the programs mounted now ([design.md](design.md#1-a-page-host-in-core)).
- **bb and Powermove use the same model.** A folder with a manifest and one entry function; registrations owned by the extension and released together; esbuild plus a cache-busting re-import; shared libraries taken from the host; the old version kept when a reload fails; no sandbox for the team's own extensions ([prior-art.md](prior-art.md)).
- **Powermove's agent pipeline is the one to copy.** The agent edits a staging copy, the app validates an immutable snapshot of it, swaps it in under a journal, and records each agent run as a change set that can be undone ([prior-art.md](prior-art.md#agent-pipeline)).
- **Foldkit pages are closed.** A page's Model and Message are fixed Schemas, so extension code cannot run inside another page's update and view. Extensions contribute whole pages, or data that host pages render in slots ([design.md](design.md#4-slots-in-existing-pages)).

## Decisions (2026-11-23)

1. **Placement:** the page host goes into `@hyper-effect/core`; the extension system is a package of this repository, `packages/jellyware`; the first app is `examples/jellyware` ([placement.md](placement.md#decided-2026-11-23)).
2. **Not released:** all of it stays on the local branch `jellyware` of this repository. It is not pushed, and no changesets are added.
3. **Graft** is used behind one wrapper module. If the extension system needs features Graft lacks, or uses only a few of its features, the wrapper is replaced by our own code ([graft.md](graft.md#decision)).
4. **The agent** is [pi](https://github.com/badlogic/pi-mono), signed in with the Codex `auth.json`. The prompting UI comes after the extension system.

## Open questions

1. When extensions from people outside the team get a process of their own ([design.md](design.md#8-trust)).

## Sources

The repositories were read at these commits:

| Repository | Commit | Date |
|---|---|---|
| [graftland/graft](https://github.com/graftland/graft) | `6ed75d5` | 2026-11-16 |
| [get-bb/bb](https://github.com/get-bb/bb) | `796cdcc` | 2026-11-21 |
| [iterative-computer/powermove](https://github.com/iterative-computer/powermove) | `ea49609` | 2026-11-18 |
| hyper-effect | `3a8d26e` | 2026-11-18 |
