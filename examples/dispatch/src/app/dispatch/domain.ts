import { Schema as S, SchemaIssue } from 'effect'

/* Dispatch: field incidents around Munich, worked on by several dispatchers
   at once. Shared by the server pages and the map island. */

export const Severity = S.Literals(['low', 'medium', 'high'])
export type Severity = typeof Severity.Type

export const Status = S.Literals(['open', 'assigned', 'resolved'])
export type Status = typeof Status.Type

export const Location = S.Struct({ longitude: S.Number, latitude: S.Number })
export type Location = typeof Location.Type

export const Comment = S.Struct({ author: S.String, text: S.String, at: S.Number })
export type Comment = typeof Comment.Type

export const Incident = S.Struct({
  id: S.String,
  title: S.String,
  severity: Severity,
  status: Status,
  location: Location,
  assignee: S.NullOr(S.String),
  createdAt: S.Number,
  comments: S.Array(Comment),
})
export type Incident = typeof Incident.Type

export const Activity = S.Struct({
  id: S.Number,
  at: S.Number,
  text: S.String,
  incidentId: S.NullOr(S.String),
})
export type Activity = typeof Activity.Type

/** What the "new incident" form must produce. The messages are what the
 *  dispatcher sees next to the fields. */
export const NewIncident = S.Struct({
  title: S.String.pipe(
    S.check(
      S.isMinLength(4, { message: 'Describe the incident in at least 4 characters.' }),
      S.isMaxLength(80, { message: 'Keep the title under 80 characters.' }),
    ),
  ),
  severity: Severity,
  location: S.NullOr(Location).pipe(
    S.check(
      S.makeFilter((location: Location | null) => location !== null, {
        message: 'Click the map to place the incident.',
      }),
    ),
  ),
})
export type NewIncident = typeof NewIncident.Type

export const CommentText = S.String.pipe(
  S.check(
    S.isMinLength(1, { message: 'Write something first.' }),
    S.isMaxLength(500, { message: 'Keep comments under 500 characters.' }),
  ),
)

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

/** Field errors keyed by the first path segment ('' for the whole value). */
export const fieldErrors = (issue: SchemaIssue.Issue): Readonly<Record<string, string>> => {
  const errors: Record<string, string> = {}
  for (const { path, message } of formatIssues(issue).issues) {
    const first = path?.[0]
    const field =
      first === undefined ? '' : String(typeof first === 'object' ? first.key : first)
    errors[field] ??= message
  }
  return errors
}

export const severityLabel: Readonly<Record<Severity, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

export const statusLabel: Readonly<Record<Status, string>> = {
  open: 'Open',
  assigned: 'Assigned',
  resolved: 'Resolved',
}

export const formatTime = (millis: number): string =>
  new Date(millis).toISOString().slice(11, 16)
