/* What an extension's island imports in the browser (inside its frame):
   the contract and `runIsland`. */

export { type IslandSpec, defineIsland, islandPorts } from './contract.ts'
export { runIsland } from './frame.ts'
