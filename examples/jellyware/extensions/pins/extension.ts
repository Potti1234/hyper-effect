import { Effect, Layer, Stream } from 'effect'

import { PageHost } from '@hyper-effect/core'
import { Contributions, ExtensionData } from '@hyper-effect/jellyware'

import { action, extension, issueSidebar, pageOptions } from '#app/extensions'
import { Workspace } from '#app/store'

import * as Pinned from './page.ts'
import { pinsOf, toggle } from './pins.ts'

/* Pinned issues: a card on every issue page to pin it for oneself, and a
   page /pinned with the member's pins. The pins live in the extension's own
   table (`pins`, from the migration in extension.json), so they survive new
   versions, undo and restarts. */

export default extension(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const data = yield* ExtensionData
      const workspace = yield* Workspace
      const pages = yield* PageHost
      yield* pages.mount(Pinned.program, { ...pageOptions, path: Pinned.PATH })
      const contributions = yield* Contributions
      yield* contributions.nav({ id: 'pins', label: 'Pinned', href: Pinned.PATH, icon: 'pin' })

      yield* issueSidebar('pins', ({ issueId, memberId }) =>
        data.changes.pipe(
          Stream.mapEffect(() => pinsOf(data, memberId)),
          Stream.map(rows => {
            const pinned = rows.some(row => row.issue_id === issueId)
            return {
              title: 'Pinned',
              items: [],
              actions: [action(pinned ? 'Unpin' : 'Pin for me', 'pins.toggle', { issueId })],
              note: pinned ? 'On your Pinned page.' : null,
            }
          }),
          Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
        ),
      )

      yield* contributions.command({
        id: 'pins.toggle',
        run: ({ args, memberId }) =>
          Effect.gen(function* () {
            const issueId = typeof args === 'object' && args !== null && 'issueId' in args ? String(args.issueId) : ''
            const issue = (yield* workspace.current).issues.find(candidate => candidate.id === issueId)
            if (issue === undefined) return yield* Effect.fail('That issue no longer exists.')
            return yield* toggle(data, memberId, issue.id, issue.identifier)
          }),
      })
    }),
  ),
)
