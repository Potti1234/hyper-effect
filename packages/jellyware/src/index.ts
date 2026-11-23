/* @hyper-effect/jellyware: extensions for hyper-effect apps, loaded, swapped
   and unloaded while the app runs. Not released; see docs/jellyware/.

   An app provides the graph, the page host and the contributions registry,
   and loads a folder of extensions:

     Extensions.layer({ directory: 'extensions', requires: [PageHost, Contributions, Workspace], watch: true })
       .pipe(Layer.provide(graph), Layer.provide([pageHost, Contributions.layer, ...])) */

export { Contributions, NavEntry } from './contributions.ts'
export { graph, type Graph, type MountState, type Provided, type Requirement } from './graft.ts'
export { ExtensionStatus, Extensions, Manifest, layer, type Options } from './loader.ts'
