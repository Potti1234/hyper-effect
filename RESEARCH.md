# hyper-effect: research notes

A hypermedia framework for Effect, in the spirit of htmx, templ and Datastar.
Research date: 2026-10-22.

## 1. What the reference projects actually are

They do three different jobs. A framework for Effect needs to decide which of them it does itself.

| | Where it runs | What it provides |
|---|---|---|
| **htmx 4** (released 2026-08-28) | Browser (JS lib) | `hx-*` attributes that issue requests and swap HTML fragments. Server-agnostic: the protocol is just HTML plus `HX-*` headers. |
| **Datastar 1.x** | Browser (JS lib) plus backend SDKs | `data-*` attributes with signals (client reactivity). The backend streams **SSE events** that patch elements and signals. |
| **templ** | Server (Go) | Type-safe HTML components. Compiles `.templ` files to Go, ships an LSP, does context-aware escaping, and supports fragments and streaming. |

So: **htmx and Datastar are client runtimes plus wire protocols. templ is a server-side view layer.**
An Effect hypermedia framework is mostly the templ half plus server-side adapters for the
htmx and Datastar protocols. Don't write a new client runtime at the start; target the existing ones.

### htmx 4: what matters for the server
- `fetch()` replaces XHR, which enables streamed responses. Morphing (idiomorph) is built in.
- `<hx-partial hx-target="#x" hx-swap="beforeend">…</hx-partial>` updates several targets in one response.
- `hx-sse`, `hx-ws` and `hx-multipart` (`multipart/mixed` streaming) are available.
- Attribute inheritance is explicit now: `hx-confirm:inherited="…"`.
- 4xx responses (for example 422) are swapped by default. Only 204/304 skip the swap. This makes server-rendered form errors easy.
- **Request headers:** `HX-Request`, `HX-Request-Type` (`partial`|`full`), `HX-Current-URL`, `HX-Source`, `HX-Target`, `HX-Boosted`, `HX-History-Restore-Request`.
- **Response headers:** `HX-Trigger`, `HX-Location`, `HX-Redirect`, `HX-Refresh`, `HX-Retarget`, `HX-Reswap`, `HX-Reselect`, `HX-Push-Url`, `HX-Replace-Url`.
- History no longer uses localStorage snapshots. On back navigation htmx re-fetches the page, so your full-page routes must always work.
- npm `latest` is still 2.x until early 2027. 4.x is under `next`.

### Datastar: what matters for the server
- **Requests:** actions `@get/@post/@put/@patch/@delete/@query`. Signals are sent as the `datastar` query param on GET and as a JSON body otherwise. Every request carries the header `Datastar-Request: true`. Signals prefixed with `_` are local and not sent. `contentType: 'form'` submits a form instead.
- **SSE events** (`text/event-stream`):
  - `datastar-patch-elements`: `selector`, `mode` (`outer` (default), `inner`, `replace`, `prepend`, `append`, `before`, `after`, `remove`), `namespace` (`svg`/`mathml`), `useViewTransition`, `elements`.
  - `datastar-patch-signals`: `signals` (a JSON value, where `null` deletes a signal) and `onlyIfMissing`.
- **Non-SSE responses** also work: `text/html` (with `datastar-selector`/`datastar-mode` headers), `application/json` (patches signals), `text/javascript` (executes), and 204.
- **"Tao":** the backend is the source of truth. Use signals sparingly. Prefer "fat morph" (send big HTML and let the morph diff it). Use CQRS: **one long-lived SSE stream for reads, short requests for writes**. Brotli-compress SSE. Avoid optimistic UI.
- The official TS SDK (`@starfederation/datastar-sdk`, separate repo) is small: `readSignals`, `stream`, `patchElements`, `patchSignals`, `executeScript`. The protocol is easy to implement natively on Effect's SSE encoder, so we don't need the SDK.

### templ: features worth copying
- Component = `Render(ctx, io.Writer) error`. Children are passed via `@Comp() { … }` / `{ children... }`. An implicit `ctx` carries request-scoped data.
- **Fragments:** `@templ.Fragment("name") { … }` plus `templ.WithFragments("name")` renders the whole template but emits only the named part. One template serves both the full page and the htmx partial.
- **Streaming:** `templ.WithStreaming()` plus `@templ.Flush() { … }`. Suspense-like out-of-order rendering uses Declarative Shadow DOM `<slot>`s and needs no JS.
- Context-aware escaping and URL sanitising (`templ.SafeURL`). `templ.Raw` is the explicit escape hatch.
- templ needs a code generator and an LSP **only because Go has no JSX**. TypeScript does, so we get most of templ's tooling for free.

## 2. What Effect already gives us (Effect 4.0.5 is `latest` on npm)

Everything we need lives in `effect/unstable/*` after the v4 package consolidation:

- `effect/unstable/http`: `HttpRouter` (`add`, `addAll`, `prefixPath`, `middleware`, `serve`, `toWebHandler`, `schemaParams`, `schemaPathParams`, `schemaJson`), `HttpServerRequest`, `HttpServerResponse` (`html`, **`htmlStream`**, `stream`, `setHeader`, cookies, `redirect`), `HttpStaticServer`, `Etag`, `Multipart`.
- `effect/unstable/http/Template`: a tagged template whose interpolations may be values, `Option`s, `Effect`s or `Stream`s. **The `E` and `R` types of interpolated effects propagate into the result type.** `HttpServerResponse.html` and `HttpServerResponse.htmlStream` are built on it.
  - ⚠️ **It does not HTML-escape.** `primitiveToString` returns strings verbatim, so it is not safe for user data. We need our own escaping layer.
- `effect/unstable/encoding/Sse`: SSE `encode` and `encoder`, with schema-based events. This is the base for the Datastar adapter.
- `effect/unstable/httpapi`: declarative endpoints with Schema. It has `HttpApiSchema.asText({ contentType: "text/html" })`, `asFormUrlEncoded` (form posts) and `StreamSse` (typed SSE endpoints). HttpApi also gives OpenAPI and typed clients, and those clients already know how to build URLs from endpoint definitions. We can reuse that to generate typed `href`/`hx-post`/`@post(...)` values.
- `effect/unstable/reactivity` (`Reactivity`, `Atom`, …): key-based invalidation. It fits "re-render this view when X changes" well.
- Core: `Stream`, `PubSub`, `Scope` (the client disconnects → the fiber is interrupted → resources are released), `Schedule` (heartbeats and retries), `Schema` (signals, forms, params), and `Context`/`Layer` (request-scoped services, the equivalent of templ's `ctx`).

### Prior art in the Effect ecosystem
- [tatemz/effect-htmx](https://github.com/tatemz/effect-htmx): a demo of HttpApi plus Bun plus htmx, with views from `@thi.ng/hiccup`. It's an example app, not a framework.
- I found no Effect-native Datastar SDK and no Effect-native typed-HTML/JSX library. **The space is open.**
- Adjacent TS work: Hono JSX (streaming plus async components), `@kitajs/html` (JSX → string, with a TS plugin for XSS detection), `@srdjan/hsx` (branded typed routes in JSX, so writing a raw `hx-get` string is an error), `hono-htmx`. Typed-route prior art in other languages: htmxology and axum-routing-htmx (Rust), Phoenix `routes` (Elixir).

## 3. The design questions

### 3.1 How you write HTML (the main decision)

| Option | Attribute and prop checking | E/R propagation from effectful children | Tooling |
|---|---|---|---|
| **JSX** (custom `jsxImportSource`) | ✅ full, via `JSX.IntrinsicElements` | ❌ every JSX expression has the single type `JSX.Element`, so child component types are lost | Free: tsc, every editor |
| **Tagged template** (`html\`…\``) | ❌ (needs a TS plugin like lit-analyzer) | ✅ the same trick as Effect's `Template` | Weak |
| **Function DSL** (`h.div(attrs, children)`, as in Elm/Foldkit) | ✅ | ✅ (union of children's E/R) | Fine, but verbose for markup-heavy pages |

The **JSX limitation is fundamental**: TypeScript gives every JSX expression the type `JSX.Element`,
whatever the factory returns. So `<UserCard/>` cannot carry `Effect<…, DbError, UserRepo>` up to the page.

**Recommendation: JSX for markup, keep views pure, load data in handlers.** This is the templ model: components
take data as props. The handler is an `Effect.gen` that yields services and then renders. Where async
components are really wanted (streaming, Suspense), use an explicit component whose **prop** is type-checked:

```tsx
<Await effect={loadStats(userId)} fallback={<Spinner/>}>{(stats) => <Stats {...stats}/>}</Await>
```

with `effect: Effect<A, RenderError, Hyper.Context>`. Here `Hyper.Context` is a **registered app-wide service
union** declared through module augmentation, like TanStack Router's `Register` pattern. You get a type error
if a view needs a service the app does not provide. The renderer then provides the context and runs it.

Typing notes for JSX:
- Datastar v1 attributes such as `data-on:click` and htmx 4's `hx-confirm:inherited` are JSX *namespaced attribute names*. TS parses them since 5.1. Type them with template-literal keys, for example `` [K: `data-on:${string}`]: DsExpr ``.
- Generate `IntrinsicElements` from the VS Code HTML custom data or `@webref` (SSX does this) instead of hand-writing them.

### 3.2 Escaping and safety (non-negotiable)
- Escape text and attributes by default, and make the escaping context-aware: text, attribute, URL (block `javascript:`), `<script>`/`<style>`, and JSON inside `data-signals`.
- Use branded types `SafeHtml`, `SafeUrl` and `Raw`. Raw is explicit and greppable.
- Datastar expressions (`data-on:click="$count++"`) are **JS code in an attribute**. Interpolating user data into them is an injection vector. Provide an expression builder (`ds.set(sig.count, …)`, `ds.post(route, …)`) that emits JSON-encoded literals, and make raw strings opt-in.

### 3.3 Typed routes and hypermedia controls
This is where Effect can beat everyone. Define routes once with Schema:

```ts
const Todos = Routes.make({
  page:   Route.get("/todos"),
  toggle: Route.post("/todos/:id/toggle", { path: Schema.Struct({ id: TodoId }) }),
  create: Route.post("/todos", { form: CreateTodo }),          // Schema-decoded form
  live:   Route.sse("/todos/live"),
})
```

- The handler gets decoded `path`/`query`/`form`/`signals`. A decode failure becomes a **422 re-rendering the form with errors** (htmx 4 swaps 422s by default).
- Views reference routes as values, never strings: `<a href={Todos.page()}>`, `hx-post={Todos.toggle({ id })}`, `data-on:click={ds.post(Todos.toggle, { id })}`. If you rename a route or change a param, the type check fails in every view that uses it.
- Either build this on `HttpApi` (and also get OpenAPI and a typed test client) or as a thin layer over `HttpRouter`. HttpApi's endpoint/group model maps cleanly, but it is JSON-centred. Check how much it costs to make HTML first-class there (`asText({contentType:"text/html"})`, plus form payloads) before you commit to it.

### 3.4 Protocol adapters as Effect services

**`Htmx`**
```ts
const htmx = yield* Htmx.Request          // isHtmx, type: "partial"|"full", target, source, currentUrl, boosted, historyRestore
return Htmx.respond(<TodoItem todo={t}/>, {
  trigger: { todoToggled: { id } },        // HX-Trigger (JSON)
  pushUrl: Todos.page(),                   // HX-Push-Url (typed)
  partials: [Htmx.partial("#count", "innerHTML", <Count n={n}/>)],  // <hx-partial>
})
```
- Page vs. partial: one view serves both, like templ fragments. The layout wraps the content only when `HX-Request-Type: full` or when `HX-Request` is absent. That's cheaper than templ's run-everything-then-filter approach.
- Add `Vary: HX-Request` (and the related headers) automatically so caches don't mix full pages and partials.

**`Datastar`**
```ts
const Signals = Schema.Struct({ title: Schema.String, _editing: Schema.Boolean })
const signals = yield* Datastar.signals(Signals)   // reads ?datastar= or JSON body, Schema-decoded

return Datastar.sse(Stream.make(
  Datastar.patchElements(<TodoItem todo={t}/>),                 // default mode outer → morph by id
  Datastar.patchSignals({ title: "" }),
))
```
- Encode with `effect/unstable/encoding/Sse` and send with `HttpServerResponse.stream`, using content-type `text/event-stream`.
- The same Schema also produces the `data-signals` initial attribute and typed signal references (`sig.title` → `$title`), so the server and the client agree on signal names and types.
- Handle the non-SSE response types too (`text/html` with `datastar-selector`/`datastar-mode`, and JSON) for simple cases.

### 3.5 Streaming and live views (Effect's strongest selling point)
- **Out-of-order streaming SSR:** render the shell, flush, then merge (`Stream.merge`) the `Await` boundaries as they resolve. Emit each as Declarative Shadow DOM slots (templ's approach, no JS) or as `<hx-partial>`/`datastar-patch-elements` chunks. `HttpServerResponse.htmlStream` shows the server mechanics already work.
- **Live views (Datastar CQRS):** `Route.sse` opens one long-lived stream per page. The handler becomes
  `changes.pipe(Stream.debounce(…), Stream.mapEffect(render), Stream.map(patchElements))`, where `changes` comes from `PubSub`, `Reactivity` keys, DB notifications, or `@effect/cluster` for multi-node fan-out.
  - Disconnect → interruption → `Scope` finalisers unsubscribe. Add heartbeats with `Schedule.spaced`. On reconnect, send a full "fat morph" so no diffing state is needed server-side.
  - Brotli/gzip compression middleware for SSE. Morph payloads compress very well.
  - This is close to Phoenix LiveView, but stateless per connection. It is a strong differentiator for Effect.

### 3.6 Developer experience
- No codegen: JSX plus tsc covers what templ needs `templ generate` and an LSP for.
- Dev server: `bun --hot` / `node --watch`, plus a dev-only SSE endpoint that reloads the browser on rebuild (templ's proxy does the same).
- Testing: views are pure functions, so you can snapshot `renderToString(<X/>)` and run handlers through `HttpRouter.toWebHandler` with `@effect/vitest`. A small `TestDatastar` helper can parse SSE responses back into typed events.
- Observability is free: every render and handler is a span (`Effect.withSpan`), using the wide-event logging Effect already supports.
- Islands for heavy interactivity: Foldkit has a `customElement` module. Mounting Foldkit custom elements inside hypermedia pages is a natural way to pair it with your existing Foldkit work.

## 4. Proposed package layout and roadmap

```
@hyper-effect/html      Html AST, JSX runtime + types, context-aware escaping, renderToString / renderToStream, <Await>
@hyper-effect/server    Routes (Schema), typed links, page/partial/layout, form decoding + 422, HttpRouter/HttpApi glue
@hyper-effect/datastar  Signals schema, ds.* expression builder, SSE events, live views
@hyper-effect/htmx      Request/response header services, <hx-partial>, hx-* typings
```

1. **Spike (1 to 2 weeks):** JSX runtime with escaping, `renderToString`, and one Datastar todo app on `HttpRouter` with SSE patch-elements. Check that it feels right.
2. **Typed routes and forms:** route values, link builders, Schema form decoding, 422 re-render. Decide here between HttpApi and plain HttpRouter.
3. **Streaming:** `<Await>`, out-of-order flush, `R` checked against the registered context.
4. **Live views:** PubSub/Reactivity → morph stream, heartbeats, compression.
5. **htmx adapter:** headers, partials, typings. This is cheap once the core exists.
6. Later: dev reload, an attribute-typing generator, docs and examples, and maybe a TS language-service plugin that validates Datastar expressions.

### Which client to target first?
- **Datastar first (my recommendation):** its whole model is "backend streams patches over SSE", which maps one-to-one onto `Stream`. The protocol is tiny, and nobody has built the Effect integration yet.
- **htmx:** larger ecosystem and simpler request/response mental model. Adding it later is a thin adapter, because the core (HTML, routes, streaming) is shared. htmx 4's `hx-sse` and `<hx-partial>` bring the two models closer together anyway.

## 5. Risks and open questions
- `effect/unstable/*` APIs (http, httpapi, encoding) are still marked **unstable** in 4.0. Expect breaking changes; pin versions.
- The JSX `JSX.Element` typing limit means effectful components can never be fully inferred. The design has to accept "pure views plus explicit `<Await>`".
- Datastar Pro attributes (`data-persist`, `data-query-string`, `data-replace-url`, …) are commercial. Only type the core attributes by default.
- htmx 4 is still on npm `next` until early 2027. Supporting both 2.x and 4.x header sets adds work, so it's probably best to target 4 only.
- Is Effect's `Template` worth reusing? It needs an escaping wrapper, and it doesn't solve attribute typing.

## 6. Decisions so far (2026-10-22)

- **Client:** Datastar first.
- **Architecture:** a server-side Elm-architecture runtime, as in Foldkit. Model, Message, pure update/view, Commands and Subscriptions run on the server. Datastar is the terminal: Messages arrive via `@post`, and the view goes back as a full-page morph over SSE.
- **Model location: option C.** Every page first renders as plain SSR of `view(init(flags))`. A long-lived SSE connection then hosts a session runtime (fiber plus `SubscriptionRef<Model>`). `@post`s dispatch Messages and return 204. On reconnect the session re-inits from flags and sends a full morph.
- **Views: Foldkit style** (`h.div([attrs], [children])`), not JSX. This supersedes the JSX recommendation in §3.1.
  - JSX would not let us reuse React components. Their behavior lives in hooks and the React runtime, and their handlers are closures.
- **Reuse Foldkit's view layer instead of writing our own.** Verified in foldkit 0.165:
  - `foldkit/experimental/server` ships `renderToString`/`serializeHtml` (escaping, skips event handlers) and SSR plus hydration.
  - `view(model, h: HtmlBuilder<Message>)` takes an injected builder.
  - `Attribute<Message>` is a `Data.TaggedEnum`, so `OnClick(msg)` is plain data until an element is built.
  - hyper-effect can therefore provide an `HtmlBuilder` whose element constructors turn `On*` attributes into Datastar `data-on:*` attributes. Everything else is reused.
- **crease/ui:**
  - Stateless components take `h: HtmlBuilder<Msg>` as a parameter, so they should render on the server unchanged. The catalog has 94 stateless and 27 stateful components.
  - Stateful components that use `Mount` (positioning, focus) are browser-only. They become Foldkit islands, native HTML (`popover`, `<dialog>`, `<details>`), or signal-driven variants.

## 7. Spike results (2026-10-22)

See `README.md`. All of the following were confirmed by 15 vitest tests and a Chromium check run at 0 ms and 300 ms simulated latency:
- crease button, card, input and badge render on the server unchanged through a builder swap.
- The server-side update loop works, including Commands and Subscriptions.
- `ClientMessage` rejects forged Messages.

Two Datastar defaults needed handling:
- **Morph overwriting focused inputs.** Solved with client-owned inputs: `data-preserve-attr`, plus a signal patch when the Model diverges from the client.
- **Request cancellation dropping Messages.** Solved with `requestCancellation: 'disabled'` for Messages.

## 8. Dispatch demo and the closed gaps (2026-10-22)

See `README.md`. A two-page app (board plus incident details) uses shared live state, presence, Schema-validated forms, a crease toggle-group as a server-side Submodel, and the crease MapLibre map as a Foldkit island.

Verified by:
- 23 vitest tests;
- `check:dispatch` (two dispatchers, 0–300 ms random POST latency), 18/18 in repeated runs;
- `check:restart` (server killed under an open page; selection and draft survive).

What the browser tests forced into the framework:
- sequence numbers;
- a pending-input flush on every post;
- never cancelling requests;
- handler tables kept for 30 s instead of only the last render;
- connection state as a Message (presence followed sessions instead of tabs);
- islands mounted inside a `data-ignore-morph` wrapper (Foldkit replaces its container);
- browser-only Commands of server Submodels reported once instead of erroring.

crease/ui: the `crease-theme` registry item now ships its `@layer base` (`registry/theme/registry.json` in the crease repo, uncommitted).

## Sources
- htmx 4 announcement: https://four.htmx.org/announcements/2026-08-28-htmx-4.0.0-is-released
- htmx 4 reference: https://four.htmx.org/reference
- Datastar reference: https://data-star.dev/reference, SSE events: https://data-star.dev/reference/sse_events, actions: https://data-star.dev/reference/actions
- Tao of Datastar: https://data-star.dev/guide/the_tao_of_datastar
- Datastar TS SDK: https://github.com/starfederation/datastar-typescript
- templ: https://templ.guide/, fragments: https://templ.guide/syntax-and-usage/fragments/, streaming: https://templ.guide/server-side-rendering/streaming/
- Effect v4 source (http, httpapi, encoding/Sse, Template): https://github.com/Effect-TS/effect-smol/tree/main/packages/effect/src/unstable
- Effect 4.0 release coverage: https://zeli.app/story/49925812 (secondary source; npm shows `effect@4.0.5` as `latest`)
- effect-htmx example: https://github.com/tatemz/effect-htmx
- Hono JSX server rendering: https://www.mintlify.com/honojs/hono/jsx/server-rendering
- @kitajs/html: https://docsearch.algolia.com/mcp/docs/repo/kitajs/html
- HSX typed routes: https://jsr.io/@srdjan/hsx/doc
- SSX: https://github.com/oscarotero/ssx/
