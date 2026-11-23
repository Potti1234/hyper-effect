import type { Activity, Comment, Issue, Member, Priority, Status, TeamKey } from './domain'

/* Seed data: six people, two teams and about forty issues, as a small product
   team's tracker would look on a Tuesday. Times are relative to `now`. */

export const SEED_MEMBERS: ReadonlyArray<Member> = [
  { id: 'ada', name: 'Ada Lovelace', color: 'bg-indigo-500', isDark: false },
  { id: 'grace', name: 'Grace Hopper', color: 'bg-emerald-500', isDark: false },
  { id: 'linus', name: 'Linus Torvalds', color: 'bg-amber-500', isDark: false },
  { id: 'margaret', name: 'Margaret Hamilton', color: 'bg-rose-500', isDark: false },
  { id: 'alan', name: 'Alan Turing', color: 'bg-sky-500', isDark: false },
  { id: 'katherine', name: 'Katherine Johnson', color: 'bg-violet-500', isDark: false },
]

type Row = readonly [
  team: TeamKey,
  title: string,
  status: Status,
  priority: Priority,
  assignee: string | null,
  labels: ReadonlyArray<string>,
  daysAgo: number,
  description?: string,
]

const ROWS: ReadonlyArray<Row> = [
  ['ENG', 'Search results flash empty before loading', 'in_progress', 2, 'ada', ['bug'], 3, 'When typing quickly in the search box the result list renders empty for a frame before the new results arrive.\n\nExpected: keep the previous results until the new ones are in.'],
  ['ENG', 'Rate-limit the public issues API', 'todo', 1, 'linus', ['security'], 2, 'We have no limit on `/api/issues`. One customer script made 40k requests in an hour yesterday.\n\nAdd a token bucket per API key, 100 req/min, with `Retry-After`.'],
  ['ENG', 'Migrate attachments to the new storage bucket', 'in_progress', 3, 'grace', ['improvement'], 9, 'Move the remaining 1.2 TB of attachments, keep the old URLs working with redirects.'],
  ['ENG', 'Crash when pasting an image into a comment', 'in_review', 1, 'margaret', ['bug'], 1, 'Pasting a PNG from the clipboard into the comment box throws `TypeError: cannot read properties of undefined (reading "type")`.'],
  ['ENG', 'Keyboard shortcut cheat sheet', 'backlog', 4, null, ['feature', 'docs'], 21, 'A `?` overlay listing every shortcut, grouped by area.'],
  ['ENG', 'Cold start of the API takes 4s', 'todo', 2, 'alan', ['performance'], 5, 'Profile the boot: most of it seems to be the ORM building its metadata.'],
  ['ENG', 'Sync drafts across devices', 'backlog', 3, null, ['feature'], 30],
  ['ENG', 'Webhook retries never back off', 'done', 2, 'linus', ['bug'], 14, 'Failed deliveries are retried every second forever. Use exponential backoff with jitter, give up after 24h.'],
  ['ENG', 'Upgrade to Postgres 17', 'in_progress', 3, 'grace', ['improvement'], 12],
  ['ENG', 'Notifications are sent twice for mentions', 'todo', 2, 'ada', ['bug'], 4, 'A mention in a comment creates two notifications when the mentioned person is also subscribed to the issue.'],
  ['ENG', 'Bulk edit: change the priority of many issues at once', 'in_review', 3, 'katherine', ['feature'], 8],
  ['ENG', 'Audit log export as CSV', 'backlog', 4, null, ['feature'], 40],
  ['ENG', 'Memory leak in the realtime gateway', 'in_progress', 1, 'linus', ['bug', 'performance'], 2, 'RSS grows about 80 MB per hour on every gateway pod. Heap snapshots point at the presence map never dropping closed sockets.'],
  ['ENG', 'Document the GraphQL pagination model', 'todo', 4, 'katherine', ['docs'], 6],
  ['ENG', 'SAML sign-in for enterprise workspaces', 'backlog', 2, null, ['feature', 'security'], 25],
  ['ENG', 'Flaky test: board drag and drop', 'todo', 3, 'alan', ['bug'], 3],
  ['ENG', 'Cache team settings on the edge', 'canceled', 4, 'grace', ['performance'], 33],
  ['ENG', 'Issue identifiers skip numbers after a failed create', 'done', 3, 'margaret', ['bug'], 18],
  ['ENG', 'Add `updatedAt` to the issue webhooks', 'done', 4, 'ada', ['improvement'], 20],
  ['ENG', 'Command palette: fuzzy match on identifiers', 'in_review', 3, 'alan', ['improvement'], 7],
  ['ENG', 'Slow query on the My issues view', 'todo', 1, 'margaret', ['performance'], 1, 'p95 is 1.8s for workspaces with more than 20k issues. Missing index on (assignee_id, status).'],
  ['ENG', 'Email digest shows deleted comments', 'backlog', 3, 'ada', ['bug'], 11],
  ['ENG', 'Rotate the signing keys for session cookies', 'todo', 2, 'linus', ['security'], 9],
  ['ENG', 'Support Markdown tables in descriptions', 'backlog', 0, null, ['feature'], 45],
  ['ENG', 'Offline mode for the desktop app', 'canceled', 3, null, ['feature'], 60],
  ['ENG', 'Timezone bug in due dates', 'done', 2, 'katherine', ['bug'], 16],
  ['DES', 'Redesign the empty states', 'in_progress', 3, 'katherine', ['design'], 6, 'Every list and board needs an empty state that says what goes there and offers the first action.'],
  ['DES', 'New issue modal: property buttons are too small', 'todo', 2, 'margaret', ['design', 'improvement'], 3],
  ['DES', 'Icon set for priorities', 'done', 3, 'katherine', ['design'], 15],
  ['DES', 'Dark mode contrast review', 'in_review', 2, 'grace', ['design'], 4, 'Several secondary texts fall below 4.5:1 on the dark sidebar.'],
  ['DES', 'Onboarding checklist illustrations', 'backlog', 4, null, ['design'], 28],
  ['DES', 'Board card density options', 'todo', 3, 'katherine', ['design', 'feature'], 7],
  ['DES', 'Marketing site: changelog page', 'in_progress', 3, 'ada', ['design'], 10],
  ['DES', 'Avatar fallback colors look random', 'backlog', 4, 'margaret', ['design'], 19],
  ['DES', 'Prototype the timeline view', 'in_review', 2, 'alan', ['design', 'feature'], 9],
  ['DES', 'Typography scale for the issue page', 'done', 3, 'katherine', ['design'], 22],
  ['DES', 'Mobile: issue list is cramped', 'todo', 1, 'grace', ['design', 'bug'], 2, 'On a 375px screen the identifier and the title overlap.'],
  ['DES', 'Accessibility audit of the command palette', 'backlog', 2, null, ['design', 'improvement'], 12],
  ['DES', 'Label color picker', 'canceled', 4, 'margaret', ['design'], 35],
  ['DES', 'Status icons in the sidebar views', 'todo', 4, null, ['design'], 5],
]

const COMMENTS: ReadonlyArray<readonly [identifier: string, author: string, body: string, hoursAgo: number]> = [
  ['ENG-13', 'grace', 'Confirmed on staging: the presence map keeps entries for closed sockets.', 30],
  ['ENG-13', 'linus', 'Fix is up, needs a review. The map is now keyed by connection id and cleaned up on close.', 6],
  ['ENG-4', 'ada', 'Repro: copy any screenshot, paste into a comment. Happens in Chrome and Firefox.', 20],
  ['ENG-4', 'margaret', 'The clipboard item has no `type` for some screenshot tools. Guarding it now.', 4],
  ['ENG-2', 'alan', 'Should the limit be per key or per workspace? Some customers use one key for everything.', 12],
  ['DES-4', 'katherine', 'I went through the sidebar and the issue page, list attached. Most issues are in the muted text color.', 18],
  ['ENG-21', 'alan', 'Adding the index cut it to 90ms on a copy of the big workspace.', 2],
]

export type SeedState = Readonly<{
  issues: ReadonlyArray<Issue>
  comments: ReadonlyArray<Comment>
  activity: ReadonlyArray<Activity>
  counters: Readonly<Record<TeamKey, number>>
}>

export const seed = (now: number): SeedState => {
  const counters: Record<TeamKey, number> = { ENG: 0, DES: 0 }
  const day = 86_400_000
  const issues: Array<Issue> = []
  const activity: Array<Activity> = []
  ROWS.forEach(([team, title, status, priority, assignee, labels, daysAgo, description], index) => {
    counters[team] += 1
    const number = counters[team]
    const createdAt = now - daysAgo * day - (index % 7) * 3_600_000
    const creatorId = assignee ?? 'katherine'
    const issue: Issue = {
      id: `iss_${index + 1}`,
      team,
      number,
      identifier: `${team}-${number}`,
      title,
      description: description ?? '',
      status,
      priority,
      assigneeId: assignee,
      labelIds: labels,
      creatorId,
      createdAt,
      updatedAt: createdAt + Math.min(daysAgo, 2) * 3_600_000,
    }
    issues.push(issue)
    activity.push({ id: `a_seed_${index}`, issueId: issue.id, actorId: creatorId, kind: 'created', text: 'created the issue', at: createdAt })
    if (status !== 'backlog' && status !== 'todo') {
      activity.push({
        id: `a_seed_${index}_s`,
        issueId: issue.id,
        actorId: assignee ?? creatorId,
        kind: 'status',
        text: `changed status from Todo to ${status === 'in_progress' ? 'In Progress' : status === 'in_review' ? 'In Review' : status === 'done' ? 'Done' : 'Canceled'}`,
        at: issue.updatedAt,
      })
    }
  })
  const comments: Array<Comment> = COMMENTS.flatMap(([identifier, author, body, hoursAgo], index) => {
    const issue = issues.find(candidate => candidate.identifier === identifier)
    return issue === undefined
      ? []
      : [{ id: `c_seed_${index}`, issueId: issue.id, authorId: author, body, createdAt: now - hoursAgo * 3_600_000 }]
  })
  return { issues, comments, activity, counters }
}
