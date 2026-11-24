/* @hyper-effect/jellyware: extensions for hyper-effect apps, loaded, swapped
   and unloaded while the app runs. Not released; see docs/jellyware/.

   An app provides the graph, the page host and the contributions registry,
   and loads a folder of extensions:

     Extensions.layer({ directory: 'extensions', requires: [PageHost, Contributions, Workspace], watch: true })
       .pipe(Layer.provide(graph), Layer.provide([pageHost, Contributions.layer, ...])) */

export {
  type Agent,
  AgentError,
  ChangedExtension,
  Changes,
  type Check,
  Run,
  ReviewRefused,
  RunState,
  type Task,
  UndoRefused,
  layer as changesLayer,
  type Options as ChangesOptions,
} from './changes.ts'
export {
  Badge,
  type BadgeEntry,
  BadgeTone,
  type CommandEntry,
  type CommandInput,
  Contributions,
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
} from './contributions.ts'
export { DiffLine, FileDiff, diffFolders, diffLines } from './diff.ts'
export { DEFAULT_GLOBALS, DEFAULT_NAMES, type ImportRules, type NamedImports, checkFolder, findProblems, importCheck } from './imports.ts'
export { type AppPage, type GuideInput, type GuideOptions, type SlotInfo, guide, renderGuide } from './guide.ts'
export { graph, type Graph, type MountState, type Provided, type Requirement } from './graft.ts'
export { ExtensionStatus, Extensions, Manifest, SettingsChange, layer, type Options } from './loader.ts'
export { ExtensionSettings, SettingField, SettingSpec, type SettingValue } from './settings.ts'
