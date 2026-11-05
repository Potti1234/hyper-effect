# @hyper-effect/island

Foldkit programs that run in the browser inside a server-rendered hyper-effect page, for everything that needs client-side reactivity: maps, canvases, drag and drop, file inputs.

```sh
npm install @hyper-effect/island@alpha
```

Before 0.1 the packages are published on the `alpha` dist-tag. To start a new app: `npm create hyper-effect@alpha my-app`.

| Entry | Runs in | Contents |
|---|---|---|
| `@hyper-effect/island/contract` | both | `define({ tag, Props, Event })`: the two Schemas the page and the island share |
| `@hyper-effect/island` | server | `view(spec, { id, props, onEvent }, h)`: renders the custom element with its props and binds its events to Messages |
| `@hyper-effect/island/client` | browser | `register(spec, make)`: a custom element that embeds the Foldkit program and wires its Ports |
| `@hyper-effect/island/vite` | build | `islandsBuild({ entry, outDir })`: Vite config for the islands bundle |

Props travel as JSON in `data-props`; a morph that changes them reaches the island's inbound Port. Events leave through the outbound Port as `island-event` DOM events. The island's DOM sits in a `data-ignore-morph` wrapper, so morphs never rebuild it.

Import the contract from `/contract` in browser code: the package root pulls in server rendering.
