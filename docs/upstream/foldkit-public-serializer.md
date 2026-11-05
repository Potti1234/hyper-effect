# Upstream ask (Foldkit): a public serializer without re-validation

Draft issue for foldkit/foldkit.

## What hyper-effect needs

A supported way to turn an `Html` value into an HTML string without the parse5 re-validation pass, for example one of:
- `import { serializeHtml } from 'foldkit/experimental/server'`;
- `renderToString(view, { validate: false })`.

## Why

hyper-effect runs Foldkit Programs on a server and re-renders a page on every change, then sends the HTML to the browser as a morph. `renderToString` serializes the vnode tree and then parses its own output with parse5 to validate it (raw `InnerHTML` fragments, document-structure escapes, hydration shape). On that workload the validation is about 70% of the render cost ([performance.md](../performance.md)).

hyper-effect keeps the validation in development and tests, where it catches real mistakes, and skips it in production. To do that it imports the serializer by path, `foldkit/dist/experimental/server/serialize.js`, which `exports` hides, so `packages/core/src/foldkit-internal.ts` walks `node_modules` to find it. Any Foldkit release can move or change that file, so the Foldkit version is pinned exactly.

## Proposed shape

```ts
/** Serializes `html` exactly as `renderToString` does, without re-parsing
 *  the result. For callers that validated the same view shape already. */
export const serializeHtml: (html: Html) => string
```

Either form keeps validation as the default for `renderToString`.

## Related asks

Listed in [roadmap.md](../roadmap.md#upstream-asks): the injected `HtmlBuilder` and `ChildAttribute.boundaryMappers` as supported API, no `captureCallSite` stack traces per Submodel per render in production, `Dom` operations as an Effect service, and (for [design-latency.md](../design-latency.md) section 6) hydrating one Submodel in the browser from server-rendered markup and an encoded Model.
