import { Clock, Effect, Schema as S, Stream } from 'effect'

import type { ExtensionData } from '@hyper-effect/jellyware'

import type { Issue } from '#app/domain'
import type { Workspace } from '#app/store'

/* Pins in the extension's own table (extension.json declares it): which
   issues a member pinned, and when. */

export const PinRow = S.Struct({ issue_id: S.String, pinned_at: S.Number })
const decodeRows = S.decodeUnknownEffect(S.Array(PinRow))

export type Pinned = Readonly<{ issue: Issue; pinnedAt: number }>

type Data = ExtensionData['Service']

/** A member's pins, newest first. */
export const pinsOf = (data: Data, memberId: string) =>
  data
    .query('SELECT issue_id, pinned_at FROM pins WHERE member_id = ? ORDER BY pinned_at DESC', [memberId])
    .pipe(Effect.flatMap(decodeRows), Effect.orDie)

/** Pins an issue for a member, or unpins it; answers with a line for them. */
export const toggle = (data: Data, memberId: string, issueId: string, identifier: string) =>
  Effect.gen(function* () {
    const removed = yield* data.run('DELETE FROM pins WHERE member_id = ? AND issue_id = ?', [memberId, issueId])
    if (removed > 0) return `Unpinned ${identifier}.`
    yield* data.run('INSERT INTO pins (member_id, issue_id, pinned_at) VALUES (?, ?, ?)', [memberId, issueId, yield* Clock.currentTimeMillis])
    return `Pinned ${identifier}.`
  }).pipe(Effect.mapError(error => error.message))

/** The pinned issues that still exist, with when they were pinned. */
export const withIssues = (rows: ReadonlyArray<typeof PinRow.Type>, issues: ReadonlyArray<Issue>): ReadonlyArray<Pinned> =>
  rows.flatMap(row => {
    const issue = issues.find(candidate => candidate.id === row.issue_id)
    return issue === undefined ? [] : [{ issue, pinnedAt: row.pinned_at }]
  })

/** A member's pinned issues, now and after every pin or workspace change. */
export const pinnedChanges = (data: Data, workspace: Workspace['Service'], memberId: string): Stream.Stream<ReadonlyArray<Pinned>> =>
  Stream.zipLatest(data.changes, workspace.changes).pipe(
    Stream.mapEffect(([, state]) => Effect.map(pinsOf(data, memberId), rows => withIssues(rows, state.issues))),
    Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
  )
