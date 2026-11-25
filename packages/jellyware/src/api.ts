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
  type ContributionsOptions,
  CurrentExtension,
  Inventory,
  NavEntry,
  SlotAction,
  SlotBadge,
  SlotCard,
  SlotContent,
  type SlotContext,
  type SlotEntry,
  SlotItem,
} from './contributions.ts'
export { DataError, ExtensionData, type Row, type SqlValue } from './data.ts'
export { ExtensionSettings, SettingField, SettingSpec, type SettingValue, type SettingValues, isMemberSetting } from './settings.ts'
export type { Provided, Requirement } from './graft.ts'
export { type MemberKind, type RemoteService, remoteService } from './isolation/remote.ts'
