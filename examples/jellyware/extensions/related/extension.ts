import { Effect, Layer, Schema as S, Stream } from 'effect'

import { Contributions, type SlotContent } from '@hyper-effect/jellyware'

import { type Issue, isClosed } from '#app/domain'
import { action, extension, issueSidebar } from '#app/extensions'
import { Workspace } from '#app/store'

/* Related issues: a card under each issue's properties (slot
   `issue.sidebar`) with up to five open issues that share a label with it,
   kept live, and the action "Mark urgent", which runs this extension's
   command `related.mark-urgent`. */

const MAX = 5

const relatedTo = (issue: Issue, issues: ReadonlyArray<Issue>): ReadonlyArray<Issue> =>
  issues
    .filter(other => other.id !== issue.id && !isClosed(other.status) && other.labelIds.some(id => issue.labelIds.includes(id)))
    .slice(0, MAX)

const cardFor = (issueId: string, issues: ReadonlyArray<Issue>): SlotContent => {
  const issue = issues.find(candidate => candidate.id === issueId)
  if (issue === undefined) return { title: 'Related', items: [], actions: [], note: null }
  const related = relatedTo(issue, issues)
  return {
    title: 'Related',
    items: related.map(other => ({ label: other.title, detail: other.identifier, href: `/issue/${other.identifier}` })),
    actions: issue.priority === 1 ? [] : [action('Mark urgent', 'related.mark-urgent', { issueId })],
    note: related.length === 0 ? 'No open issue shares a label with this one.' : null,
  }
}

const MarkUrgent = S.Struct({ issueId: S.String })
const decodeMarkUrgent = S.decodeUnknownEffect(MarkUrgent)

export default extension(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const workspace = yield* Workspace

      yield* issueSidebar('related', ({ issueId }) =>
        workspace.changes.pipe(
          Stream.map(state => cardFor(issueId, state.issues)),
          Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
        ),
      )

      const contributions = yield* Contributions
      yield* contributions.command({
        id: 'related.mark-urgent',
        run: ({ args, memberId }) =>
          Effect.gen(function* () {
            const { issueId } = yield* decodeMarkUrgent(args).pipe(Effect.mapError(() => 'That is not an issue.'))
            const issue = (yield* workspace.current).issues.find(candidate => candidate.id === issueId)
            if (issue === undefined) return yield* Effect.fail('That issue no longer exists.')
            yield* workspace
              .update([{ id: issueId, patch: { priority: 1 } }], memberId)
              .pipe(Effect.mapError(() => `${issue.identifier} could not be changed.`))
            return `Marked ${issue.identifier} urgent.`
          }),
      })
    }),
  ),
)
