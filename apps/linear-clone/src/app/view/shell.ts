import type { Html, HtmlBuilder } from 'foldkit/html'

import * as Icon from '@/lib/icon'
import { cn } from '@/lib/utils'
import { kbd } from '@/ui/kbd'

import { type Member, TEAMS, firstName } from '../domain'
import { avatar, teamBadge } from './icons'

/* The app shell: Linear's left sidebar and the frame around a page. Each
   page renders it (pages are separate programs; navigation is a page load),
   with the counts it keeps live. */

export type NavCounts = Readonly<{ my: number; ENG: number; DES: number }>

export type SidebarProps<Msg> = Readonly<{
  me: Member
  /** The href of the page shown, to highlight its entry. */
  active: string
  counts: NavCounts
  /** New issue: a Message on pages that have the dialog, a link elsewhere. */
  onCreate: Readonly<{ message: Msg } | { href: string }>
  /** Opens the command palette (Ctrl/Cmd+K). */
  onPalette?: Msg
  isDark: boolean
  onToggleTheme: Msg
}>

export const VIEWS: ReadonlyArray<Readonly<{ href: string; label: string; icon: string }>> = [
  { href: '/issues?label=bug&status=todo,in_progress,in_review', label: 'Active bugs', icon: 'circle-alert' },
  { href: '/issues?priority=1,2&status=backlog,todo,in_progress,in_review', label: 'Urgent & high', icon: 'zap' },
  { href: '/issues?assignee=none&status=backlog,todo', label: 'Unassigned', icon: 'user-round-x' },
]

const NAV_ITEM =
  'group flex h-7 w-full items-center gap-2 rounded-md px-2 text-[13px] font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground'

const navLink = <Msg>(
  h: HtmlBuilder<Msg>,
  config: Readonly<{ href: string; label: string; icon: Html; isActive: boolean; count?: number; indent?: boolean }>,
): Html =>
  h.a(
    [
      h.Href(config.href),
      h.Class(cn(NAV_ITEM, config.indent === true && 'pl-7', config.isActive && 'bg-sidebar-accent text-sidebar-foreground')),
      ...(config.isActive ? [h.AriaCurrent('page')] : []),
    ],
    [
      h.span([h.Class('flex w-4 shrink-0 justify-center text-muted-foreground group-hover:text-sidebar-foreground')], [config.icon]),
      h.span([h.Class('flex-1 truncate')], [config.label]),
      ...(config.count === undefined || config.count === 0
        ? []
        : [h.span([h.Class('text-[11px] tabular-nums text-muted-foreground')], [String(config.count)])]),
    ],
  )

const sectionHeading = <Msg>(h: HtmlBuilder<Msg>, label: string): Html =>
  h.div([h.Class('px-2 pt-4 pb-1 text-[11px] font-medium text-muted-foreground')], [label])

export const sidebar = <Msg>(props: SidebarProps<Msg>, h: HtmlBuilder<Msg>): Html => {
  const createButton = 'message' in props.onCreate
    ? h.button(
        [
          h.Type('button'),
          h.Id('sidebar-create'),
          h.AriaLabel('New issue (C)'),
          h.Title('New issue  C'),
          h.Class('flex size-7 items-center justify-center rounded-md border bg-background text-foreground shadow-xs hover:bg-accent'),
          h.OnClick(props.onCreate.message),
        ],
        [Icon.icon('pencil', { class: 'size-3.5' }, h)],
      )
    : h.a(
        [
          h.Href(props.onCreate.href),
          h.AriaLabel('New issue (C)'),
          h.Title('New issue  C'),
          h.Class('flex size-7 items-center justify-center rounded-md border bg-background text-foreground shadow-xs hover:bg-accent'),
        ],
        [Icon.icon('pencil', { class: 'size-3.5' }, h)],
      )
  return h.aside(
    [
      h.Id('sidebar'),
      h.AriaLabel('Sidebar'),
      h.Class('flex h-screen w-60 shrink-0 flex-col border-r bg-sidebar px-2.5 py-2.5 text-sidebar-foreground'),
    ],
    [
      h.div(
        [h.Class('flex items-center gap-2 px-1 pb-2')],
        [
          h.div(
            [h.Class('flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1')],
            [
              h.span(
                [h.Class('flex size-[22px] items-center justify-center rounded-md bg-gradient-to-br from-indigo-500 to-violet-600 text-[11px] font-bold text-white')],
                ['A'],
              ),
              h.span([h.Class('truncate text-[13px] font-semibold')], ['Acme']),
            ],
          ),
          ...(props.onPalette === undefined
            ? []
            : [
                h.button(
                  [
                    h.Type('button'),
                    h.AriaLabel('Command menu (Ctrl+K)'),
                    h.Title('Command menu  Ctrl K'),
                    h.Class('flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground'),
                    h.OnClick(props.onPalette),
                  ],
                  [Icon.icon('search', { class: 'size-3.5' }, h)],
                ),
              ]),
          createButton,
        ],
      ),
      h.nav(
        [h.AriaLabel('Main'), h.Class('flex min-h-0 flex-1 flex-col overflow-y-auto')],
        [
          navLink(h, {
            href: '/my-issues',
            label: 'My issues',
            icon: Icon.icon('circle-user', { class: 'size-4' }, h),
            isActive: props.active === '/my-issues',
            count: props.counts.my,
          }),
          navLink(h, {
            href: '/issues',
            label: 'All issues',
            icon: Icon.icon('layout-grid', { class: 'size-4' }, h),
            isActive: props.active === '/issues',
          }),
          sectionHeading(h, 'Your teams'),
          ...TEAMS.flatMap(team => [
            h.div(
              [h.Class('flex h-7 items-center gap-2 px-2 text-[13px] font-medium')],
              [teamBadge(team.color, team.key.charAt(0), h), h.span([h.Class('truncate')], [team.name])],
            ),
            navLink(h, {
              href: `/team/${team.key}`,
              label: 'Issues',
              icon: Icon.icon('list', { class: 'size-4' }, h),
              isActive: props.active === `/team/${team.key}`,
              count: props.counts[team.key],
              indent: true,
            }),
            navLink(h, {
              href: `/team/${team.key}?view=board`,
              label: 'Board',
              icon: Icon.icon('columns-3', { class: 'size-4' }, h),
              isActive: props.active === `/team/${team.key}?view=board`,
              indent: true,
            }),
          ]),
          sectionHeading(h, 'Views'),
          ...VIEWS.map(view =>
            navLink(h, {
              href: view.href,
              label: view.label,
              icon: Icon.icon(view.icon, { class: 'size-4' }, h),
              isActive: props.active === view.href,
            }),
          ),
        ],
      ),
      h.div(
        [h.Class('flex items-center gap-2 border-t px-1 pt-2.5')],
        [
          avatar(props.me, h, 'md'),
          h.span([h.Class('min-w-0 flex-1 truncate text-[13px] font-medium')], [firstName(props.me.name)]),
          h.button(
            [
              h.Type('button'),
              h.Id('theme-toggle'),
              h.AriaLabel(props.isDark ? 'Use light theme' : 'Use dark theme'),
              h.Title(props.isDark ? 'Light theme' : 'Dark theme'),
              h.Class('flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground'),
              h.OnClick(props.onToggleTheme),
            ],
            [Icon.icon(props.isDark ? 'sun' : 'moon', { class: 'size-3.5' }, h)],
          ),
          // Signing out is a navigation (a form post), not an event.
          h.form(
            [h.Method('post'), h.Action('/logout')],
            [
              h.button(
                [
                  h.Type('submit'),
                  h.AriaLabel('Sign out'),
                  h.Title('Sign out'),
                  h.Class('flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground'),
                ],
                [Icon.icon('log-out', { class: 'size-3.5' }, h)],
              ),
            ],
          ),
        ],
      ),
    ],
  )
}

/** A key hint, as Linear shows next to actions. */
export const hint = <Msg>(h: HtmlBuilder<Msg>, ...keys: ReadonlyArray<string>): Html =>
  h.span([h.Class('inline-flex gap-0.5')], keys.map(key => kbd({ children: [key], class: 'h-[18px] min-w-[18px] text-[11px]' }, h)))
