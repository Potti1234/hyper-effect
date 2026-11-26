/* What extensions themselves import from @hyper-effect/jellyware: the
   registry and the settings, without the loader, the run pipeline or the
   import check (which pulls in the TypeScript compiler). An extension
   running in its own process is bundled against this entry. */

export {
  Badge,
  type BadgeEntry,
  BadgeTone,
  type CommandEntry,
  type CommandInput,
  Contributions,
  type DataEntry,
  type ContributionsOptions,
  CurrentExtension,
  Inventory,
  NavEntry,
  SlotAction,
  SlotBadge,
  SlotCard,
  SlotContent,
  type SlotContext,
  type SlotRead,
  type SlotEntry,
  SlotItem,
  SlotValue,
} from './contributions.ts'
export { type DataSlot, dataSlot } from './data-slot.ts'
export { DataError, ExtensionData, type Row, type SqlValue } from './data-service.ts'
export { type IslandSpec, defineIsland, islandPorts } from './islands/contract.ts'
export { ExtensionIslands, type IslandViewConfig, islandView } from './islands/view.ts'
export { ExtensionSettings, SettingField, SettingSpec, type SettingValue, type SettingValues, isMemberSetting } from './settings.ts'
export type { Provided, Requirement } from './graft.ts'
export { type MemberKind, type RemoteService, remoteService } from './isolation/remote.ts'
