import type { Html, HtmlBuilder } from 'foldkit/html'

import { cn } from '@/lib/utils'
import { badge } from '@/ui/badge'
import { button, buttonVariants } from '@/ui/button'

import type { User } from './auth'
import { type Status, statusLabel } from './catalog/domain'

/* Page chrome shared by the admin pages. */

export const HEADER_ID = 'page-header'

export const header = <Message>(user: User, h: HtmlBuilder<Message>): Html =>
  h.header(
    [
      h.Id(HEADER_ID),
      h.Class('flex flex-wrap items-center justify-between gap-3 border-b bg-background px-4 py-3 sm:px-6'),
    ],
    [
      h.a(
        [h.Href('/products'), h.Class('flex items-center gap-2 text-base font-semibold')],
        [
          h.span(
            [h.Class('flex size-7 items-center justify-center rounded-md bg-primary text-sm text-primary-foreground')],
            ['C'],
          ),
          'Catalog admin',
        ],
      ),
      h.div(
        [h.Class('flex items-center gap-2 text-sm text-muted-foreground')],
        [
          h.span([], [user.name]),
          badge({ children: [user.role], variant: user.role === 'editor' ? 'default' : 'secondary' }, h),
          // A plain form post: signing out is a navigation, not an event.
          h.form(
            [h.Method('post'), h.Action('/logout')],
            [button({ children: ['Sign out'], type: 'submit', variant: 'ghost', size: 'sm' }, h)],
          ),
        ],
      ),
    ],
  )

const statusVariant = { active: 'default', draft: 'outline', archived: 'secondary' } as const

export const statusBadge = <Message>(status: Status, h: HtmlBuilder<Message>): Html =>
  badge({ children: [statusLabel[status]], variant: statusVariant[status] }, h)

/** A link that looks like a button. */
export const linkButton = <Message>(
  config: Readonly<{ href: string; label: string; variant?: 'default' | 'outline' | 'ghost'; size?: 'sm' | 'default' }>,
  h: HtmlBuilder<Message>,
): Html =>
  h.a(
    [
      h.Href(config.href),
      h.Class(cn(buttonVariants({ variant: config.variant ?? 'default', size: config.size ?? 'default' }))),
    ],
    [config.label],
  )

export const formatDate = (millis: number): string =>
  new Date(millis).toISOString().slice(0, 16).replace('T', ' ')
