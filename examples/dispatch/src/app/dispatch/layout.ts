import type { Html, HtmlBuilder } from 'foldkit/html'

import { cn } from '@/lib/utils'
import { badge } from '@/ui/badge'
import { button } from '@/ui/button'

import { type Severity, type Status, severityLabel, statusLabel } from './domain'

/* View helpers shared by the Dispatch pages. */

/** Presence is in every page, so its size multiplies by the number of pages:
 *  show a few names (yourself first) and a count. */
const SHOWN_ON_DUTY = 5

const shownOnDuty = (config: Readonly<{ me: string; online: ReadonlyArray<string> }>) => {
  const others = config.online.filter(name => name !== config.me)
  const me = config.online.includes(config.me) ? [config.me] : []
  return [...me, ...others].slice(0, SHOWN_ON_DUTY)
}

/** The header's id, so pages can make it a region. */
export const HEADER_ID = 'page-header'

export const header = <Message>(
  config: Readonly<{ me: string; online: ReadonlyArray<string> }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.header(
    [
      h.Id(HEADER_ID),
      h.Class('flex flex-wrap items-center justify-between gap-3 border-b bg-background px-4 py-3 sm:px-6'),
    ],
    [
      h.a(
        [h.Href('/'), h.Class('flex items-center gap-2 text-base font-semibold')],
        [
          h.span(
            [h.Class('flex size-7 items-center justify-center rounded-md bg-primary text-sm text-primary-foreground')],
            ['D'],
          ),
          'Dispatch',
        ],
      ),
      h.div(
        [h.Class('flex flex-wrap items-center gap-2 text-sm text-muted-foreground')],
        [
          h.span([h.Class('hidden sm:inline')], ['On duty:']),
          ...shownOnDuty(config).map(name =>
            badge(
              {
                children: [name],
                variant: name === config.me ? 'default' : 'secondary',
              },
              h,
            ),
          ),
          ...(config.online.length > SHOWN_ON_DUTY
            ? [h.span([h.Class('text-xs')], [`+${config.online.length - SHOWN_ON_DUTY} more`])]
            : []),
          // A plain form post: signing out is a navigation, not an event.
          h.form(
            [h.Method('post'), h.Action('/logout')],
            [button({ children: ['Sign out'], type: 'submit', variant: 'ghost', size: 'sm' }, h)],
          ),
        ],
      ),
    ],
  )

const severityVariant = {
  high: 'destructive',
  medium: 'secondary',
  low: 'outline',
} as const

export const severityBadge = <Message>(severity: Severity, h: HtmlBuilder<Message>): Html =>
  badge({ children: [severityLabel[severity]], variant: severityVariant[severity] }, h)

const statusClass: Readonly<Record<Status, string>> = {
  open: 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200',
  assigned: 'bg-sky-100 text-sky-900 dark:bg-sky-900/30 dark:text-sky-200',
  resolved: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200',
}

export const statusBadge = <Message>(status: Status, h: HtmlBuilder<Message>): Html =>
  badge(
    { children: [statusLabel[status]], variant: 'ghost', class: cn('border-0', statusClass[status]) },
    h,
  )

export const sectionTitle = <Message>(
  title: string,
  h: HtmlBuilder<Message>,
  aside: ReadonlyArray<Html | string> = [],
): Html =>
  h.div(
    [h.Class('flex items-center justify-between gap-2')],
    [h.h2([h.Class('text-sm font-semibold')], [title]), ...aside],
  )
