import { Effect, type Layer, Schema as S, type Scope, Stream } from 'effect'
import { KeyValueStore } from 'effect/persistence'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { type Options, type PageRequest, PageHost, region, secretFromEnvironment } from '@hyper-effect/core'
import {
  type Badge,
  Contributions,
  type ExtensionData,
  type ExtensionSettings,
  NavEntry,
  type Provided,
  type SlotAction,
  type SlotContent,
  type SlotInfo,
} from '@hyper-effect/jellyware'

import { cn } from '@/lib/utils'

import { principal, requireUser } from './auth'
import { Member, type Role, isClosed } from './domain'
import { Viewers, Workspace, type WorkspaceState } from './store'
import { type NavCounts, sidebar } from './view/shell'

/* What the app offers extensions (the folder `extensions/`).

   `requires` is the list every extension is mounted with: an extension's
   layer may use these services and no others, and `extension` checks that
   at compile time. Then: the slots the app's pages offer, with a helper
   each, and `CUSTOMIZATIONS`, the list of everything an extension can
   change, which /extensions shows and the agent's guide describes. Last,
   the app shell for extension pages: the signed-in member, the sidebar
   counts and entries, kept live, and the frame around a page, so an
   extension page looks like the app's own pages. */

export const requires = [PageHost, Contributions, Workspace, Viewers, KeyValueStore.KeyValueStore] as const

/** The services an extension may use. */
export type Host = Provided<typeof requires>

/** Declares an extension: its default export, checked against `Host`. Its
 *  settings (declared in extension.json) come as `ExtensionSettings`, its
 *  own database (tables from its migrations) as `ExtensionData`. */
export const extension = <E>(
  layer: Layer.Layer<never, E, Host | ExtensionSettings | ExtensionData>,
): Layer.Layer<never, E, Host | ExtensionSettings | ExtensionData> => layer

// SLOTS AND COMMANDS

/** The slot under an issue's properties. Its context: the issue shown and
 *  the member looking. */
export const ISSUE_SIDEBAR = 'issue.sidebar'

export type IssueContext = Readonly<{ issueId: string; identifier: string; memberId: string }>

/** Shows a card under an issue's properties, for the life of the
 *  extension. `content` should emit at once and again when it changes
 *  (from `Workspace.changes`, say). */
export const issueSidebar = <R>(
  id: string,
  content: (context: IssueContext) => Stream.Stream<SlotContent, never, R>,
): Effect.Effect<void, never, Contributions | Scope.Scope | R> =>
  Contributions.use(contributions =>
    contributions.slot({
      slot: ISSUE_SIDEBAR,
      id,
      content: context =>
        content({ issueId: context['issueId'] ?? '', identifier: context['identifier'] ?? '', memberId: context['memberId'] ?? '' }),
    }),
  )

/** A button for a card: runs the command `command` with `args` (JSON) for
 *  the member who clicks. Register the command with `Contributions.command`;
 *  it gets `{ args, memberId }` and answers with a line for the member. */
export const action = (label: string, command: string, args: S.Json): SlotAction => ({ label, command, args })

/** Entries in the command palette (Ctrl+K) of the issue lists. Its
 *  context: the member looking, and the selected issue (j/k), if any. */
export const ISSUES_PALETTE = 'issues.palette'

export type PaletteContext = Readonly<{ memberId: string; issueId: string | null; identifier: string | null }>

/** Adds entries to the issue lists' command palette while it is open:
 *  each action of the content becomes an entry that runs its command, each
 *  item with an `href` (a path of the app) one that opens it. The content's
 *  title is the entries' group; title it with the selected issue's
 *  identifier to list them with the issue's own actions. */
export const issuesPalette = <R>(
  id: string,
  content: (context: PaletteContext) => Stream.Stream<SlotContent, never, R>,
): Effect.Effect<void, never, Contributions | Scope.Scope | R> =>
  Contributions.use(contributions =>
    contributions.slot({
      slot: ISSUES_PALETTE,
      id,
      content: context =>
        content({
          memberId: context['memberId'] ?? '',
          issueId: context['issueId'] || null,
          identifier: context['identifier'] || null,
        }),
    }),
  )

/** Badges on the rows of the issue lists and the cards of the board. The
 *  same for every member (the rows are rendered once for everyone). */
export const ISSUES_BADGES = 'issues.badges'

/** Shows badges on issues, by issue id (`target`), for the life of the
 *  extension; `badges` should emit at once and again when they change. */
export const issueBadges = <R>(
  id: string,
  badges: Stream.Stream<ReadonlyArray<Badge>, never, R>,
): Effect.Effect<void, never, Contributions | Scope.Scope | R> =>
  Contributions.use(contributions => contributions.badges({ slot: ISSUES_BADGES, id, content: () => badges }))

/** One way an extension can change the app. */
export type Customization = Readonly<{
  id: string
  title: string
  /** Where people see it. */
  where: string
  /** A page that shows it; null when there is none to point at. */
  seeAt: string | null
  /** The slot it fills; null for pages and settings. */
  slot: string | null
  /** How an extension does it, for the agent. */
  how: string
  /** A prompt that tries it. */
  example: string
}>

/** Everything an extension can change, in the order /extensions lists it. */
export const CUSTOMIZATIONS: ReadonlyArray<Customization> = [
  {
    id: 'page',
    title: 'Pages',
    where: 'A page of its own at a new path, with an entry in the sidebar under Extensions.',
    seeAt: '/standup',
    slot: null,
    how: 'Mount a hyper-effect program with `PageHost.mount(program, { ...pageOptions, path })` and add `Contributions.nav({ id, label, href, icon })`. `standup/` is the reference.',
    example: 'Add a page that lists the issues nobody is assigned to, grouped by team, with an entry in the sidebar.',
  },
  {
    id: ISSUE_SIDEBAR,
    title: 'Cards on an issue',
    where: "On an issue's page, under its properties.",
    seeAt: '/issue/ENG-1',
    slot: ISSUE_SIDEBAR,
    how: "Add a card with `issueSidebar(id, context => Stream<SlotContent>)` from `#app/extensions`; the context has `issueId`, `identifier` (ENG-4) and `memberId` (the member looking). Buttons: `action(label, command, args)`. `related/` is the reference.",
    example: "Add a card under an issue's properties that shows how many days the issue has been open.",
  },
  {
    id: ISSUES_PALETTE,
    title: 'Command palette',
    where: 'In the command palette (Ctrl+K) of the issue lists. Actions for the selected issue (j/k) show under it.',
    seeAt: '/team/ENG',
    slot: ISSUES_PALETTE,
    how: "Add entries with `issuesPalette(id, context => Stream<SlotContent>)` from `#app/extensions`; the context has `memberId`, and `issueId` and `identifier` of the selected issue (null when none). Each action becomes an entry that runs its command (`action(label, command, args)`); each item with an `href` (a path of the app) an entry that opens it. The content's title is the entries' group: the selected issue's identifier lists them with the issue's own actions. `related/` and `standup/` are references.",
    example: 'Add a command palette entry that assigns the selected issue to me.',
  },
  {
    id: ISSUES_BADGES,
    title: 'Badges on issues',
    where: 'On the rows of the issue lists and the cards of the board.',
    seeAt: '/team/ENG?view=board',
    slot: ISSUES_BADGES,
    how: "Show badges with `issueBadges(id, Stream<ReadonlyArray<Badge>>)` from `#app/extensions`; a badge is `{ target: issueId, label, tone }`, tone one of neutral, info, success, warning, danger. Badges are the same for every member. `stale/` is the reference.",
    example: "Show a red badge 'Overdue' on urgent issues that have been open for more than three days.",
  },
  {
    id: 'settings',
    title: 'Settings',
    where: 'Values an administrator changes on this page without a prompt, such as how many issues a card shows.',
    seeAt: null,
    slot: null,
    how: "Declare `settings` in extension.json and read them while building with `ExtensionSettings`. `related/` declares three.",
    example: 'Add a setting to Related issues that hides closed issues.',
  },
]

/** The slots, described for the agent's guide (src/app/agent.ts). */
export const slotsForGuide: ReadonlyArray<SlotInfo> = CUSTOMIZATIONS.flatMap(each =>
  each.slot === null ? [] : [{ name: each.slot, where: each.where.replace(/\.$/, '').replace(/^./, c => c.toLowerCase()), how: each.how }],
)

/** For `Contributions.make`: a member's roles (`admin` or `member`), for
 *  commands that name the roles that may run them. */
export const rolesOf = (memberId: string): Effect.Effect<ReadonlyArray<Role>, never, Workspace> =>
  Effect.map(Workspace.use(workspace => workspace.current), state => {
    const member = state.members.find(each => each.id === memberId)
    return member === undefined ? [] : [member.role]
  })

/** Whether a member may change the app (/extensions). */
export const isAdmin = (member: Member): boolean => member.role === 'admin'

/** The options every page of the app is served with, extension pages
 *  included: add `path`. */
export const pageOptions: Options = {
  stylesheets: ['/styles.css'],
  // Sessions belong to the signed-in user; signing out ends them.
  principal,
  snapshotSecret: secretFromEnvironment('HYPER_SNAPSHOT_SECRET', 'dev-snapshot-secret, set HYPER_SNAPSHOT_SECRET'),
}

// SHELL

export const Counts = S.Struct({ my: S.Number, ENG: S.Number, DES: S.Number })

/** What the frame of a page shows besides the page itself. */
export const Shell = S.Struct({ me: Member, counts: Counts, nav: S.Array(NavEntry) })
export type Shell = typeof Shell.Type

const countsOf = (state: WorkspaceState, memberId: string): NavCounts => ({
  my: state.issues.filter(issue => issue.assigneeId === memberId && !isClosed(issue.status)).length,
  ENG: state.issues.filter(issue => issue.team === 'ENG' && !isClosed(issue.status)).length,
  DES: state.issues.filter(issue => issue.team === 'DES' && !isClosed(issue.status)).length,
})

/** The shell for a page request: signs the user in (or redirects to the
 *  sign-in page) and reads the workspace and the sidebar entries. */
export const loadShell = (request: PageRequest) =>
  Effect.gen(function* () {
    const name = yield* requireUser(request)
    const workspace = yield* Workspace
    const me = yield* workspace.memberFor(name)
    const state = yield* workspace.current
    const nav = yield* Contributions.use(contributions => contributions.navEntries)
    return { me, counts: countsOf(state, me.id), nav } satisfies Shell
  })

const sameShell = (a: Shell, b: Shell) =>
  a.me === b.me &&
  a.nav === b.nav &&
  a.counts.my === b.counts.my &&
  a.counts.ENG === b.counts.ENG &&
  a.counts.DES === b.counts.DES

/** The shell of `memberId`, now and after every change, for a Subscription. */
export const shellChanges = (memberId: string): Stream.Stream<Shell, never, Workspace | Contributions> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const contributions = yield* Contributions
      return Stream.zipLatest(workspace.changes, contributions.navChanges).pipe(
        Stream.map(([state, nav]): Shell | undefined => {
          const me = state.members.find(member => member.id === memberId)
          return me === undefined ? undefined : { me, counts: countsOf(state, memberId), nav }
        }),
        Stream.filter((shell): shell is Shell => shell !== undefined),
        Stream.changesWith(sameShell),
      )
    }),
  )

/** The app's frame around an extension page: the sidebar, with `active`
 *  highlighted, and `content` beside it. */
export const frame = <Msg>(shell: Shell, active: string, content: ReadonlyArray<Html>, h: HtmlBuilder<Msg>): Html =>
  h.div(
    [h.Id('app'), h.Class(cn('flex h-screen overflow-hidden bg-background text-foreground', shell.me.isDark && 'dark'))],
    [
      region(h, {
        id: 'sidebar',
        deps: [shell.me, shell.counts, shell.nav, active],
        render: () =>
          sidebar(
            {
              me: shell.me,
              active,
              counts: shell.counts,
              extensions: shell.nav,
              onCreate: { href: '/issues?new=1' },
              isDark: shell.me.isDark,
            },
            h,
          ),
      }),
      h.main([h.Class('flex min-w-0 flex-1 flex-col bg-background')], content),
    ],
  )
