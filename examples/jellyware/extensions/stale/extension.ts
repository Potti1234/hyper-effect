import { Clock, Effect, Layer, Stream } from 'effect'

import { type Badge, ExtensionSettings } from '@hyper-effect/jellyware'

import { type Issue, isClosed } from '#app/domain'
import { extension, issueBadges } from '#app/extensions'
import { Workspace } from '#app/store'

/* Stale issues: a badge "Stale 12d" on every open issue nobody changed for
   `days` days (a setting), on the rows of the issue lists and the cards of
   the board (slot `issues.badges`). Recomputed when the workspace changes
   and once an hour, as issues also go stale by time passing. */

const DAY = 24 * 60 * 60 * 1000

const staleBadges = (issues: ReadonlyArray<Issue>, now: number, days: number): ReadonlyArray<Badge> =>
  issues
    .filter(issue => !isClosed(issue.status) && now - issue.updatedAt >= days * DAY)
    .map(issue => ({ target: issue.id, label: `Stale ${Math.floor((now - issue.updatedAt) / DAY)}d`, tone: 'warning' }))

export default extension(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const days = (yield* ExtensionSettings).number('days')
      yield* issueBadges(
        'stale',
        // `tick` emits at once, then every hour.
        Stream.zipLatest(workspace.changes, Stream.tick('1 hour')).pipe(
          Stream.mapEffect(([state]) => Effect.map(Clock.currentTimeMillis, now => staleBadges(state.issues, now, days))),
          Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
        ),
      )
    }),
  ),
)
