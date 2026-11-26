/* @hyper-effect/jellyware: extensions for hyper-effect apps, loaded, swapped
   and unloaded while the app runs. Not released; see docs/jellyware/.

   An app provides the graph, the page host and the contributions registry,
   and loads a folder of extensions:

     Extensions.layer({ directory: 'extensions', requires: [PageHost, Contributions, Workspace], watch: true })
       .pipe(Layer.provide(graph), Layer.provide([pageHost, Contributions.layer, ...])) */

export {
  Activity,
  ActivityState,
  type Agent,
  AgentError,
  type AgentEvent,
  ChangedExtension,
  Changes,
  type Check,
  Run,
  ReviewRefused,
  RunState,
  StartRefused,
  type Task,
  UndoRefused,
  threadOf,
  declaredMismatch,
  layer as changesLayer,
  parseDeclared,
  type Options as ChangesOptions,
} from './changes.ts'
export {
  Badge,
  type BadgeEntry,
  BadgeTone,
  type CommandEntry,
  type CommandInput,
  Contributions,
  type DataEntry,
  CurrentExtension,
  Inventory,
  type ContributionsOptions,
  NavEntry,
  SlotAction,
  SlotBadge,
  SlotCard,
  SlotContent,
  type SlotContext,
  type SlotEntry,
  SlotItem,
  SlotValue,
} from './contributions.ts'
export { type DataSlot, dataSlot } from './data-slot.ts'
export { DataError, DataSummary, ExtensionData, type Row, type SqlValue, migrationsCheck } from './data.ts'
export { type CheckOptions, packageImports, testsCheck, typecheckCheck } from './checks.ts'
export { type IslandSpec, HOST_TAG, defineIsland, islandPorts } from './islands/contract.ts'
export { ExtensionIslands, type IslandViewConfig, islandView } from './islands/view.ts'
export { IslandBuildError, buildIsland, errorRoute, framePage, frameRoute, frameSrc } from './islands/build.ts'
export { DiffLine, FileDiff, diffFolders, diffLines } from './diff.ts'
export {
  DEFAULT_GLOBALS,
  DEFAULT_NAMES,
  type ImportRules,
  type NamedImports,
  checkFolder,
  findProblems,
  importCheck,
  isTestFile,
} from './imports.ts'
export { type AppPage, type GuideInput, type GuideOptions, type SlotInfo, guide, renderGuide } from './guide.ts'
export { graph, type Graph, type MountState, type Provided, type Requirement } from './graft.ts'
export { ExtensionStatus, Extensions, Manifest, MemberSettings, SettingsChange, layer, type Options } from './loader.ts'
export { ExtensionSettings, SettingField, SettingSpec, type SettingValue, type SettingValues, isMemberSetting } from './settings.ts'
export { type IsolationOptions, isolatedExtension } from './isolation/parent.ts'
export { type MemberKind, type RemoteService, remoteService } from './isolation/remote.ts'
