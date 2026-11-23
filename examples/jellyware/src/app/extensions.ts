import { Effect, type Layer, Schema as S, Stream } from 'effect'
import { KeyValueStore } from 'effect/persistence'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { type Options, type PageRequest, PageHost, region, secretFromEnvironment } from '@hyper-effect/core'
import { Contributions, NavEntry, type Provided } from '@hyper-effect/jellyware'

import { cn } from '@/lib/utils'

import { principal, requireUser } from './auth'
import { Member, isClosed } from './domain'
import { Viewers, Workspace, type WorkspaceState } from './store'
import { type NavCounts, sidebar } from './view/shell'

/* What the app offers extensions (the folder `extensions/`).

   `requires` is the list every extension is mounted with: an extension's
   layer may use these services and no others, and `extension` checks that
   at compile time. The rest of this module is the app shell for extension
   pages: the signed-in member, the sidebar counts and entries, kept live,
   and the frame around a page, so an extension page looks like the app's
   own pages. */

export const requires = [PageHost, Contributions, Workspace, Viewers, KeyValueStore.KeyValueStore] as const

/** The services an extension may use. */
export type Host = Provided<typeof requires>

/** Declares an extension: its default export, checked against `Host`. */
export const extension = <E>(layer: Layer.Layer<never, E, Host>): Layer.Layer<never, E, Host> => layer

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
