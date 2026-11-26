import { Effect } from 'effect'

import { type HostedPage, PageHost } from '@hyper-effect/core'

import { Contributions, type Inventory } from './contributions.ts'
import { type ExtensionStatus, Extensions } from './loader.ts'
import { type SettingField, isMemberSetting } from './settings.ts'

/* A guide to what the app has now, written for the agent before each run
   (after bb's generated plugin-commands skill, docs/jellyware/prior-art.md):
   the pages and their paths, the slots with their cards, the commands and
   who may run them, the sidebar entries, and per extension its settings
   and what it adds. The ids and paths in it are taken, so the agent picks
   free ones instead of guessing, and it knows where to look for each
   thing. Generated from the running app, not from the files: what failed
   to load says so, with its error. */

/** A page or route of the app itself, which the page host does not serve. */
export type AppPage = Readonly<{ name: string | null; paths: ReadonlyArray<string> }>

/** A slot the app's pages offer, described for the agent. */
export type SlotInfo = Readonly<{
  name: string
  /** Where it shows ("under an issue's properties"). */
  where: string
  /** How to add a card, and what the content function gets. */
  how: string
}>

export type GuideOptions = Readonly<{
  appPages: ReadonlyArray<AppPage>
  slots: ReadonlyArray<SlotInfo>
}>

export type GuideInput = GuideOptions &
  Readonly<{
    extensions: ReadonlyArray<ExtensionStatus>
    inventory: Inventory
    pages: ReadonlyArray<HostedPage>
  }>

const code = (text: string) => `\`${text.replaceAll('`', "'")}\``
const from = (owner: string | null) => (owner === null ? 'the app' : `${code(`${owner}/`)}`)

const describeSetting = (field: SettingField) => {
  const spec = field.spec
  const kind =
    spec.type === 'number'
      ? `number${spec.min !== undefined || spec.max !== undefined ? ` ${spec.min ?? ''}–${spec.max ?? ''}` : ''}`
      : spec.type === 'select'
        ? `one of ${spec.options.map(code).join(', ')}`
        : spec.type === 'boolean'
          ? 'on/off'
          : spec.type === 'secret'
            ? 'secret; read it with `settings.secret(key)`, never show or log it'
            : 'text'
  const value =
    spec.type === 'secret'
      ? field.isSet
        ? 'set'
        : 'not set'
      : typeof field.value === 'boolean'
        ? field.value
          ? 'on'
          : 'off'
        : JSON.stringify(field.value)
  const scope = isMemberSetting(spec) ? '; each member may set their own, read with `settings.forMember(memberId)`' : ''
  return `${code(field.key)} (${kind}${scope}; label: ${spec.label}) is ${value}`
}

const STATE: Readonly<Record<ExtensionStatus['state'], string>> = {
  active: 'running',
  loading: 'loading',
  pending: 'waiting for a service it requires',
  failed: 'failed',
  disabled: 'turned off by an administrator (its files are kept; it does not run)',
}

/** The guide as Markdown. */
export const renderGuide = (input: GuideInput): string => {
  const lines: Array<string> = [
    '# What the app has now',
    '',
    'Generated from the running app when this run started. Every id, page name and path below is taken: pick others for new things, or change the extension that owns one. Read the files for details.',
    '',
    '## Pages',
    '',
    ...input.appPages.map(page => `- ${page.paths.map(code).join(', ')}${page.name === null ? '' : `: page ${code(page.name)}`} (the app)`),
    ...input.pages.map(page => `- ${page.paths.map(code).join(', ') || '(no path)'}: page ${code(page.name)} (${from(page.owner)})`),
    '',
    '## Slots in the app\'s pages',
    '',
  ]
  for (const slot of input.slots) {
    const cards = [...input.inventory.slots, ...input.inventory.badges, ...input.inventory.data].filter(card => card.slot === slot.name)
    lines.push(
      `- ${code(slot.name)}, ${slot.where}. ${slot.how}`,
      `  In it now: ${cards.length === 0 ? 'nothing' : cards.map(card => `${code(card.id)} (${from(card.owner)})`).join(', ')}.`,
    )
  }
  const unknown = [...input.inventory.slots, ...input.inventory.badges, ...input.inventory.data].filter(card => !input.slots.some(slot => slot.name === card.slot))
  for (const card of unknown) lines.push(`- ${code(card.slot)}: card ${code(card.id)} (${from(card.owner)}); no page of the app shows this slot.`)
  lines.push('', '## Commands', '')
  lines.push(
    ...(input.inventory.commands.length === 0
      ? ['None.']
      : input.inventory.commands.map(
          command =>
            `- ${code(command.id)} (${from(command.owner)}): ${
              command.roles === null ? 'every member who sees its button' : `only ${command.roles.map(code).join(' or ')}`
            }`,
        )),
    '',
    '## Sidebar entries',
    '',
    ...(input.inventory.nav.length === 0
      ? ['None.']
      : input.inventory.nav.map(
          ({ entry, owner }) => `- ${code(entry.id)}: "${entry.label}", icon ${code(entry.icon)}, links to ${code(entry.href)} (${from(owner)})`,
        )),
    '',
    '## Extensions',
    '',
  )
  if (input.extensions.length === 0) lines.push('None yet.')
  for (const extension of input.extensions) {
    lines.push(`### ${code(`${extension.id}/`)}: ${extension.name}, version ${extension.version}, ${STATE[extension.state]}`, '')
    if (extension.description !== null) lines.push(extension.description, '')
    if (extension.error !== null) {
      lines.push('Its error:', '', '```', ...extension.error.split('\n').slice(0, 15), '```', '')
    }
    const adds = [
      ...input.pages.filter(page => page.owner === extension.id).map(page => `page ${code(page.name)} at ${page.paths.map(code).join(', ')}`),
      ...input.inventory.nav.filter(nav => nav.owner === extension.id).map(nav => `sidebar entry ${code(nav.entry.id)}`),
      ...input.inventory.slots.filter(card => card.owner === extension.id).map(card => `card ${code(card.id)} in ${code(card.slot)}`),
      ...input.inventory.badges.filter(entry => entry.owner === extension.id).map(entry => `badges ${code(entry.id)} in ${code(entry.slot)}`),
      ...input.inventory.data.filter(entry => entry.owner === extension.id).map(entry => `value ${code(entry.id)} in ${code(entry.slot)}`),
      ...input.inventory.commands.filter(command => command.owner === extension.id).map(command => `command ${code(command.id)}`),
    ]
    lines.push(`- Adds: ${adds.length === 0 ? (extension.state === 'active' ? 'nothing the app lists' : 'nothing while it does not run') : adds.join('; ')}.`)
    if (extension.settings.length > 0) lines.push(`- Settings: ${extension.settings.map(describeSetting).join('; ')}.`)
    if (extension.islands.length > 0) lines.push(`- Islands (its own browser code, in sandboxed frames): ${extension.islands.map(code).join(', ')}.`)
    if (extension.data !== null) {
      lines.push(
        `- Data: ${extension.data.tables.map(table => `table ${code(table.name)} (${table.columns.join(', ')})`).join('; ') || 'no tables'}; ${extension.data.migrations} migration${extension.data.migrations === 1 ? '' : 's'} applied. Add new migrations after them in extension.json; never change or reorder applied ones.`,
      )
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}

/** Gathers the guide's data from the running app and renders it. */
export const guide = (options: GuideOptions): Effect.Effect<string, never, Extensions | Contributions | PageHost> =>
  Effect.gen(function* () {
    const extensions = yield* Extensions.use(each => each.current)
    const inventory = yield* Contributions.use(contributions => contributions.inventory)
    const pages = yield* PageHost.use(host => host.pages)
    return renderGuide({ ...options, extensions, inventory, pages })
  })
