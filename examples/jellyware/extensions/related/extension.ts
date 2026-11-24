import { Effect, Layer, Schema as S, Stream } from 'effect'

import { Contributions, ExtensionSettings, type SlotContent } from '@hyper-effect/jellyware'

import { type Issue, isClosed } from '#app/domain'
import { action, extension, issueSidebar, issuesPalette } from '#app/extensions'
import { Workspace } from '#app/store'

/* Related issues: a card under each issue's properties (slot
   `issue.sidebar`) with the open issues that share a label with it,
   kept live, and the action "Mark urgent", which runs this extension's
   command `related.mark-urgent`. The same action is in the issue lists'
   command palette for the selected issue (slot `issues.palette`).

   Settings (extension.json): the card's title, how many issues it shows,
   and whether it offers "Mark urgent". It refuses to show more than 10: a
   value the declaration allows (up to 20) but this version fails with, so
   the workshop's "put back when it fails" can be tried. */

const LIMIT = 10

type Options = Readonly<{ title: string; max: number; urgentAction: boolean }>

const relatedTo = (issue: Issue, issues: ReadonlyArray<Issue>, max: number): ReadonlyArray<Issue> =>
  issues
    .filter(other => other.id !== issue.id && !isClosed(other.status) && other.labelIds.some(id => issue.labelIds.includes(id)))
    .slice(0, max)

export const cardFor = (issueId: string, issues: ReadonlyArray<Issue>, options: Options): SlotContent => {
  const issue = issues.find(candidate => candidate.id === issueId)
  if (issue === undefined) return { title: options.title, items: [], actions: [], note: null }
  const related = relatedTo(issue, issues, options.max)
  return {
    title: options.title,
    items: related.map(other => ({ label: other.title, detail: other.identifier, href: `/issue/${other.identifier}` })),
    actions: issue.priority === 1 || !options.urgentAction ? [] : [action('Mark urgent', 'related.mark-urgent', { issueId })],
    note: related.length === 0 ? 'No open issue shares a label with this one.' : null,
  }
}

const MarkUrgent = S.Struct({ issueId: S.String })
const decodeMarkUrgent = S.decodeUnknownEffect(MarkUrgent)

export default extension(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const workspace = yield* Workspace
      const settings = yield* ExtensionSettings
      const options: Options = {
        title: settings.string('title'),
        max: settings.number('max'),
        urgentAction: settings.boolean('urgentAction'),
      }
      if (options.max > LIMIT) {
        return yield* Effect.fail(`Related shows at most ${LIMIT} issues; the setting asks for ${options.max}.`)
      }

      yield* issueSidebar('related', ({ issueId }) =>
        workspace.changes.pipe(
          Stream.map(state => cardFor(issueId, state.issues, options)),
          Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
        ),
      )

      // Titled with the identifier: listed with the selected issue's own entries.
      yield* issuesPalette('related', ({ issueId, identifier }) =>
        workspace.changes.pipe(
          Stream.map((state): SlotContent => {
            const issue = state.issues.find(candidate => candidate.id === issueId)
            return {
              title: identifier ?? 'Related',
              items: [],
              actions:
                issue === undefined || issue.priority === 1 || !options.urgentAction
                  ? []
                  : [action(`Mark ${issue.identifier} urgent`, 'related.mark-urgent', { issueId: issue.id })],
              note: null,
            }
          }),
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
