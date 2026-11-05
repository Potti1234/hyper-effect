/* Islands are Foldkit programs that run in the browser inside a server-driven
   page, for the parts that need client-side reactivity: maps, canvases, drag
   and drop, anything with high-frequency input or browser-only APIs.

   The contract is two Schemas:
   - `Props` flow server → island. The server renders them into the island's
     `data-props` attribute; every morph that changes them reaches the island
     through an inbound Port, so the server stays the source of truth.
   - `Event` flows island → server. The island emits it on an outbound Port;
     the custom element turns it into an `island-event` DOM event, which the
     server-side view binds like any other event and decodes with the Schema.

   Everything else (camera position, hover, animation) stays in the island's
   own Model and never touches the network.

   This module is shared: the server renders islands with `view`, the browser
   registers them with `register` from `@hyper-effect/island/client`. */

export * from './contract.ts'
export * from './view.ts'
