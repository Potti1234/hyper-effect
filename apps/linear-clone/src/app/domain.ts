import { Option, Schema as S, SchemaIssue } from 'effect'

/* The workspace's data: members, teams, labels, issues, comments and the
   activity log. Plain Schemas, so pages can keep them in their Models (which
   are snapshotted as JSON) and Messages can carry them. */

// STATUS

export const Status = S.Literals(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'])
export type Status = typeof Status.Type

export const STATUSES: ReadonlyArray<Status> = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled']

/** Order of the groups in a list and the columns on a board (Linear shows
 *  started work first). */
export const GROUP_ORDER: ReadonlyArray<Status> = ['in_review', 'in_progress', 'todo', 'backlog', 'done', 'canceled']
export const BOARD_ORDER: ReadonlyArray<Status> = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled']

export const statusLabel: Readonly<Record<Status, string>> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
  canceled: 'Canceled',
}

export const isClosed = (status: Status): boolean => status === 'done' || status === 'canceled'

// PRIORITY

/** Linear's numbering: 0 none, 1 urgent … 4 low. */
export const Priority = S.Literals([0, 1, 2, 3, 4])
export type Priority = typeof Priority.Type

export const PRIORITIES: ReadonlyArray<Priority> = [0, 1, 2, 3, 4]

export const priorityLabel: Readonly<Record<Priority, string>> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
}

/** Sort key inside a group: urgent first, no priority last. */
export const priorityRank = (priority: Priority): number => (priority === 0 ? 5 : priority)

// MEMBERS, TEAMS, LABELS

export const Member = S.Struct({
  id: S.String,
  name: S.String,
  /** A Tailwind background class from AVATAR_COLORS. */
  color: S.String,
  /** Their theme choice, applied to every page they have open. */
  isDark: S.Boolean,
})
export type Member = typeof Member.Type

export const AVATAR_COLORS: ReadonlyArray<string> = [
  'bg-indigo-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-sky-500',
  'bg-violet-500',
  'bg-teal-500',
  'bg-orange-500',
]

export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(part => part !== '')
    .slice(0, 2)
    .map(part => part.charAt(0).toUpperCase())
    .join('')

export const firstName = (name: string): string => name.split(/\s+/)[0] ?? name

export const TeamKey = S.Literals(['ENG', 'DES'])
export type TeamKey = typeof TeamKey.Type

export type Team = Readonly<{ key: TeamKey; name: string; color: string }>

export const TEAMS: ReadonlyArray<Team> = [
  { key: 'ENG', name: 'Engineering', color: 'bg-indigo-500' },
  { key: 'DES', name: 'Design', color: 'bg-pink-500' },
]

export const teamName = (key: TeamKey): string => TEAMS.find(team => team.key === key)?.name ?? key

export type Label = Readonly<{ id: string; name: string; dot: string }>

export const LABELS: ReadonlyArray<Label> = [
  { id: 'bug', name: 'Bug', dot: 'bg-red-500' },
  { id: 'feature', name: 'Feature', dot: 'bg-violet-500' },
  { id: 'improvement', name: 'Improvement', dot: 'bg-sky-500' },
  { id: 'performance', name: 'Performance', dot: 'bg-amber-500' },
  { id: 'design', name: 'Design', dot: 'bg-pink-500' },
  { id: 'docs', name: 'Docs', dot: 'bg-slate-400' },
  { id: 'security', name: 'Security', dot: 'bg-emerald-600' },
]

export const labelById = (id: string): Label | undefined => LABELS.find(label => label.id === id)

// ISSUES

export const Issue = S.Struct({
  id: S.String,
  team: TeamKey,
  number: S.Number,
  /** `ENG-12`: what people type and the URL uses. */
  identifier: S.String,
  title: S.String,
  description: S.String,
  status: Status,
  priority: Priority,
  assigneeId: S.NullOr(S.String),
  labelIds: S.Array(S.String),
  creatorId: S.String,
  createdAt: S.Number,
  updatedAt: S.Number,
})
export type Issue = typeof Issue.Type

export const Comment = S.Struct({
  id: S.String,
  issueId: S.String,
  authorId: S.String,
  body: S.String,
  createdAt: S.Number,
})
export type Comment = typeof Comment.Type

export const Activity = S.Struct({
  id: S.String,
  issueId: S.String,
  actorId: S.String,
  /** "changed status from Todo to In Progress" (the actor is shown before it). */
  text: S.String,
  /** Which property it was about, for its icon. */
  kind: S.Literals(['created', 'status', 'priority', 'assignee', 'labels', 'title', 'description']),
  at: S.Number,
})
export type Activity = typeof Activity.Type

/** What a change may touch. Absent fields stay as they are. */
export const IssuePatch = S.Struct({
  title: S.optionalKey(S.String),
  description: S.optionalKey(S.String),
  status: S.optionalKey(Status),
  priority: S.optionalKey(Priority),
  assigneeId: S.optionalKey(S.NullOr(S.String)),
  labelIds: S.optionalKey(S.Array(S.String)),
})
export type IssuePatch = typeof IssuePatch.Type

/** One issue's change; a bulk edit is several. */
export const IssueChange = S.Struct({ id: S.String, patch: IssuePatch })
export type IssueChange = typeof IssueChange.Type

// VALIDATION

export const MAX_TITLE = 200
export const MAX_DESCRIPTION = 5000
export const MAX_COMMENT = 5000

export const Title = S.String.pipe(
  S.check(
    S.isMinLength(1, { message: 'Give the issue a title.' }),
    S.isMaxLength(MAX_TITLE, { message: `Keep the title under ${MAX_TITLE} characters.` }),
  ),
)
export const Description = S.String.pipe(
  S.check(S.isMaxLength(MAX_DESCRIPTION, { message: `Keep the description under ${MAX_DESCRIPTION} characters.` })),
)
export const CommentBody = S.String.pipe(
  S.check(
    S.isMinLength(1, { message: 'Write something first.' }),
    S.isMaxLength(MAX_COMMENT, { message: `Keep comments under ${MAX_COMMENT} characters.` }),
  ),
)

export const NewIssue = S.Struct({
  team: TeamKey,
  title: Title,
  description: Description,
  status: Status,
  priority: Priority,
  assigneeId: S.NullOr(S.String),
  labelIds: S.Array(S.String),
})
export type NewIssue = typeof NewIssue.Type

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1()

/** The first message per field of a failed decode, keyed by field name. */
export const fieldErrors = (issue: SchemaIssue.Issue): Readonly<Record<string, string>> => {
  const errors: Record<string, string> = {}
  for (const { path, message } of formatIssue(issue).issues) {
    const first = path?.[0]
    const key = first === undefined ? '' : String(typeof first === 'object' ? first.key : first)
    errors[key] ??= message
  }
  return errors
}

/** Decodes a value, returning it or the first message of each failing field. */
export const validate = <A>(
  schema: S.Codec<A, unknown, never, never>,
  value: unknown,
): Readonly<{ ok: true; value: A } | { ok: false; errors: Readonly<Record<string, string>> }> => {
  const decoded = S.decodeUnknownExit(schema)(value, { errors: 'all' })
  if (decoded._tag === 'Success') return { ok: true, value: decoded.value }
  const error = decoded.cause.reasons.find(reason => reason._tag === 'Fail')?.error
  return {
    ok: false,
    errors: S.isSchemaError(error) ? fieldErrors(error.issue) : { '': 'Check the form.' },
  }
}

/** One message for a single-field Schema (title, comment). */
export const firstError = (schema: S.Codec<string, unknown, never, never>, value: string): string | null => {
  const result = validate(schema, value)
  return result.ok ? null : (Object.values(result.errors)[0] ?? 'Check this field.')
}

// FILTERS AND THE URL

export const Layout = S.Literals(['list', 'board'])
export type Layout = typeof Layout.Type

/** What a list shows, mirrored into the address bar. */
export const Query = S.Struct({
  search: S.String,
  status: S.Array(Status),
  priority: S.Array(Priority),
  /** Member ids, or `none` for unassigned. */
  assignee: S.Array(S.String),
  label: S.Array(S.String),
  layout: Layout,
})
export type Query = typeof Query.Type

export const emptyQuery: Query = { search: '', status: [], priority: [], assignee: [], label: [], layout: 'list' }

const listParam = (url: URL, name: string): ReadonlyArray<string> =>
  (url.searchParams.get(name) ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(part => part !== '')

const decodeStatus = S.decodeUnknownOption(Status)
const decodePriority = S.decodeUnknownOption(Priority)

export const queryFromUrl = (url: URL): Query => ({
  search: (url.searchParams.get('q') ?? '').slice(0, 100),
  status: listParam(url, 'status').flatMap(value => Option.toArray(decodeStatus(value))),
  priority: listParam(url, 'priority').flatMap(value => Option.toArray(decodePriority(Number(value)))),
  assignee: listParam(url, 'assignee').slice(0, 20),
  label: listParam(url, 'label').filter(value => labelById(value) !== undefined),
  layout: url.searchParams.get('view') === 'board' ? 'board' : 'list',
})

export const searchForQuery = (query: Query): string => {
  const params = new URLSearchParams()
  if (query.search.trim() !== '') params.set('q', query.search.trim())
  if (query.status.length > 0) params.set('status', query.status.join(','))
  if (query.priority.length > 0) params.set('priority', query.priority.join(','))
  if (query.assignee.length > 0) params.set('assignee', query.assignee.join(','))
  if (query.label.length > 0) params.set('label', query.label.join(','))
  if (query.layout === 'board') params.set('view', 'board')
  const search = params.toString().replace(/%2C/g, ',')
  return search === '' ? '' : `?${search}`
}

export const hasFilters = (query: Query): boolean =>
  query.status.length + query.priority.length + query.assignee.length + query.label.length > 0

export const matchesQuery = (issue: Issue, query: Query): boolean => {
  const search = query.search.trim().toLowerCase()
  return (
    (query.status.length === 0 || query.status.includes(issue.status)) &&
    (query.priority.length === 0 || query.priority.includes(issue.priority)) &&
    (query.assignee.length === 0 || query.assignee.includes(issue.assigneeId ?? 'none')) &&
    (query.label.length === 0 || issue.labelIds.some(id => query.label.includes(id))) &&
    (search === '' ||
      issue.title.toLowerCase().includes(search) ||
      issue.identifier.toLowerCase().includes(search))
  )
}

/** Inside a group: priority, then the newest first. */
export const compareIssues = (a: Issue, b: Issue): number =>
  priorityRank(a.priority) - priorityRank(b.priority) || b.createdAt - a.createdAt

// FORMATTING (deterministic: no clock, fixed time zone)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const formatDate = (at: number): string => {
  const date = new Date(at)
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`
}

export const formatDateTime = (at: number): string => {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${formatDate(at)}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}
