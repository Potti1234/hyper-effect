import type { Layer } from 'effect'

/* Finding what a composed layer still needs. With `exactOptionalPropertyTypes`
   a missing service shows up at `Layer.launch` as a page of types, far from
   the part that needs it. `provided` asks for a layer that needs nothing
   more: wrap a part of the composition with it, and the error is at that
   call, naming the missing service:

     const Services = provided(Agents.layer.pipe(Layer.provideMerge(Store.layer)))
     // Type 'Layer<Agents | Store, never, Contributions>' is not assignable
     // to type 'Layer<Agents | Store, never, never>'

   A route whose handler uses a service (not only the page's program) needs
   it per request (`Request<"Requires", S>`), which no layer provides: read
   the service while building the route instead,
   `Layer.unwrap(S.use(service => Effect.succeed(HttpRouter.add(..., handler(service)))))`. */

/** `layer`, which must need nothing more; a compile error here names what it does need. */
export const provided = <A, E>(layer: Layer.Layer<A, E, never>): Layer.Layer<A, E, never> => layer

/** The services a layer still needs. */
export type Needs<L> = L extends Layer.Layer<infer _A, infer _E, infer R> ? R : never
