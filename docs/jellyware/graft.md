# Graft: dynamic Effect layers

What Graft 0.7.0 provides, which parts an extension system for hyper-effect would use, what it leaves open, and the risk of depending on it. Read at commit `6ed75d5` of [graftland/graft](https://github.com/graftland/graft).

## What Graft is

Graft makes Effect `Layer`s dynamic. A mounted layer is built while every service it requires is available, publishes the services it provides, and is torn down, dependents first, when a requirement goes away. It depends only on `effect` (`4.1.*`) and needs Node.js 22.19 or later, the same versions hyper-effect uses (`effect` 4.1.2, `engines.node >=22.19`).

One package, `@graftland/graft`, with four entries:

| Entry | Holds |
|---|---|
| `graft` | The `Graft`, `Mount` and `Release` namespaces |
| `graft/rpc` | `Remote.service`, `Remote.serve`, `Remote.connect`: a service in another process over `effect/rpc` |
| `graft/node` | Protocols for a child process (stdio) and a worker thread |
| `graft/testing` | An in-memory protocol for tests |

The source of the main entry is about 2,400 lines (`packages/core/src/Graft.ts`, `Mount.ts`, `Release.ts`, `internal/`).

## The API

| Call | Does |
|---|---|
| `Graft.layer` | Provides the graph; given to `runMain` or a `ManagedRuntime` like any layer |
| `Graft.mount(layer, { name, requires, retry, isolate, intercept })` | Places a layer in the graph; returns a `Mount.Mount` handle |
| `Graft.optional(Key)` | A requirement that may be absent; the mount rebuilds when it comes or goes |
| `Graft.publish(Key, value)` | Places a value, such as configuration; `publication.set(next)` rebuilds everything that requires it |
| `Graft.fork(effect)` | A background fiber owned by the current mount |
| `Graft.watch`, `Graft.await`, `Graft.use`, `Graft.whileAvailable` | Read a service that comes and goes from ordinary Effect code |
| `Graft.mounts`, `Graft.logs` | Streams of the live mounts with their state, and of their logs |
| Mount handle | `state`, `await`, `stable`, `restart`, `unmount` |
| `isolate: [Key]` or `[[Key, "label"]]` | A private or labelled realm: a separate provider of that key for this mount and its children |
| `Graft.intercept(Reference, f)` | A different value of a `Context.Reference` for one mount and its children |

A failed build or background fiber puts the mount in `Failed` with the full `Cause`. With `retry: Schedule`, it is built again; the rest of the graph keeps running. Within one realm, one mount or publication provides a key; a second provider is rejected with `Graft.ServiceConflict` (`docs/isolation.md`).

## What version 0.7.0 removed

The 0.7.0 changelog (`packages/core/CHANGELOG.md`) replaced the earlier plugin framework with the library above. Removed: the plugin framework, `@graftland/loader`, `@graftland/hmr`, the CLI, the project generator and the plugin packages for HTTP, MCP and OTLP. The README says of hot reload: "Graft no longer reloads modules." Code loading is therefore not Graft's job.

## How it fits hyper-effect

`Hyper.layer(program, options)` is already a layer with a lifetime. Releasing it closes the page's live sessions and completes their snapshot writes (`packages/core/src/server.ts`, doc comment above `layer`). A page mounted with `Graft.mount` therefore gets ordered teardown, and its open sessions survive the swap through their snapshots.

Stores are Effect services. An extension that requires `Tasks` waits until the `Tasks` store is available and stops before it goes away.

## What it leaves open

**Routes.** `Hyper.layer` registers its routes with `HttpRouter.use(router => router.add(...))`: the page path and four routes under `/_hyper/<name>/`. In `effect` 4.1.2 the router looks routes up per request (`dist/http/HttpRouter.js`, `asHttpEffect`, `router.find`), so a route added after the server starts is served. There is no call to remove a route, and adding the same method and path twice throws `Method 'GET' already declared for route` (`dist/http/FindMyWay/internal/router.js:187`). Mounting a page, unmounting it and mounting it again would throw. [design.md](design.md#1-a-page-host-in-core) describes the fix.

**Code loading.** Compiling an extension, importing it again after a change, and keeping one copy of `effect` and `foldkit` across extensions. [design.md](design.md#3-loading-code) takes this from bb.

**Swapping a version.** One provider per key and realm means version N+1 of an extension cannot publish the same service keys while version N is still mounted. A swap either has a gap (unmount, then mount) or goes through a registry that allows two owners per id. [design.md](design.md#2-a-contributions-registry) uses the registry.

**Collections.** Many extensions contribute navigation entries or slot content. Graft keys hold one provider each, so a collection is a host service that extensions register into, with each registration released by the extension's mount scope.

## Which parts to use

| Need | Graft part |
|---|---|
| An extension's lifetime and cleanup | `Graft.mount`; the mount's `Scope` owns every registration |
| One broken extension does not stop the app | `Failed` state with `Cause`, `retry` |
| Extensions that depend on each other or on host services | `requires`, `Graft.optional` |
| Extension settings changed at run time | `Graft.publish`, `set` |
| A page showing what is mounted, for users and the agent | `Graft.mounts`, `Graft.logs` |
| Proving a new version builds before it goes live | A separate graph in a test run |
| Later: a variant of an extension per workspace or user | Labelled realms |
| Later: extensions in their own process | `Remote` with `graft/node`; the served services are what the extension may use |

Intercepts are not needed for a first version.

## Risks

- Version 0.7.0 was released on 2026-11-16 and rewrote the public API of 0.6.0. The changelog credits one author for both releases.
- `requires` is checked against the layer's input type, so an API change shows up as type errors, not at run time.

## Decision

Two options:

1. **Depend on `@graftland/graft`**, pinned to `0.7.0`, behind one module of ours (`Extensions`), so a breaking release changes one file.
2. **Write the subset:** mount, requires, retry, state stream. Without realms, publications, optional requirements and remote services this is a few hundred lines, but it repeats work Graft has tests for (`packages/core/test/`, teardown order, cancellation, cycles).

Decided on 2026-11-23: option 1. The teardown and cancellation cases are where hand-written plugin hosts fail, and the wrapper limits the exposure to API changes. If the extension system needs features Graft lacks, or uses only a few of its features, the wrapper is replaced by our own code.
