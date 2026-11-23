import { Clock, Context, Data, Effect, Layer, type Scope, Stream, SubscriptionRef } from 'effect'

import {
  AVATAR_COLORS,
  type Activity,
  type Comment,
  type Issue,
  type IssueChange,
  type IssuePatch,
  type Member,
  type NewIssue,
  type TeamKey,
  labelById,
  priorityLabel,
  statusLabel,
} from './domain'
import { SEED_MEMBERS, seed } from './seed'

/* The workspace: everyone's shared, live state. In memory with a change feed
   (`changes` emits the current state at once, then every new one); pages
   subscribe to it. A real deployment puts a database behind the same service
   and turns its notifications into the same stream (see the admin example's
   Postgres store). */

export type WorkspaceState = Readonly<{
  /** Increases with every change. */
  version: number
  members: ReadonlyArray<Member>
  issues: ReadonlyArray<Issue>
  comments: ReadonlyArray<Comment>
  activity: ReadonlyArray<Activity>
}>

export class IssueNotFound extends Data.TaggedError('IssueNotFound')<{ readonly id: string }> {}
export class InvalidChange extends Data.TaggedError('InvalidChange')<{ readonly reason: string }> {}

export class Workspace extends Context.Service<
  Workspace,
  {
    readonly current: Effect.Effect<WorkspaceState>
    readonly changes: Stream.Stream<WorkspaceState>
    /** The member a signed-in name belongs to; a new name joins the workspace. */
    readonly memberFor: (name: string) => Effect.Effect<Member>
    readonly create: (input: NewIssue, actorId: string) => Effect.Effect<Issue, InvalidChange>
    /** Applies changes to one or several issues at once (bulk edits). */
    readonly update: (changes: ReadonlyArray<IssueChange>, actorId: string) => Effect.Effect<void, IssueNotFound | InvalidChange>
    readonly comment: (issueId: string, body: string, authorId: string) => Effect.Effect<Comment, IssueNotFound>
    readonly remove: (id: string) => Effect.Effect<void, IssueNotFound>
    readonly setTheme: (memberId: string, isDark: boolean) => Effect.Effect<void>
  }
>()('linear/Workspace') {
  static readonly layer = Layer.effect(
    Workspace,
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const seeded = seed(now)
      const counters: Record<TeamKey, number> = { ...seeded.counters }
      let nextId = 1
      const id = (prefix: string) => `${prefix}_${now.toString(36)}_${nextId++}`
      const state = yield* SubscriptionRef.make<WorkspaceState>({
        version: 1,
        members: SEED_MEMBERS,
        issues: seeded.issues,
        comments: seeded.comments,
        activity: seeded.activity,
      })

      const modify = <A, E>(f: (current: WorkspaceState, at: number) => Effect.Effect<readonly [A, Omit<WorkspaceState, 'version'>], E>) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          const current = yield* SubscriptionRef.get(state)
          const [result, next] = yield* f(current, at)
          yield* SubscriptionRef.set(state, { ...next, version: current.version + 1 })
          return result
        })

      const memberName = (members: ReadonlyArray<Member>, memberId: string | null) =>
        memberId === null ? 'nobody' : (members.find(member => member.id === memberId)?.name ?? memberId)

      const checkPatch = (current: WorkspaceState, patch: IssuePatch): Effect.Effect<void, InvalidChange> => {
        if (patch.assigneeId !== undefined && patch.assigneeId !== null && !current.members.some(member => member.id === patch.assigneeId)) {
          return Effect.fail(new InvalidChange({ reason: 'That person is not in this workspace.' }))
        }
        if (patch.labelIds !== undefined && patch.labelIds.some(label => labelById(label) === undefined)) {
          return Effect.fail(new InvalidChange({ reason: 'Unknown label.' }))
        }
        return Effect.void
      }

      /** One activity entry per property that actually changed. */
      const describe = (members: ReadonlyArray<Member>, before: Issue, after: Issue): ReadonlyArray<Pick<Activity, 'kind' | 'text'>> => [
        ...(before.status === after.status
          ? []
          : [{ kind: 'status' as const, text: `changed status from ${statusLabel[before.status]} to ${statusLabel[after.status]}` }]),
        ...(before.priority === after.priority
          ? []
          : [{ kind: 'priority' as const, text: after.priority === 0 ? 'removed the priority' : `set priority to ${priorityLabel[after.priority]}` }]),
        ...(before.assigneeId === after.assigneeId
          ? []
          : [{ kind: 'assignee' as const, text: after.assigneeId === null ? 'removed the assignee' : `assigned the issue to ${memberName(members, after.assigneeId)}` }]),
        ...after.labelIds
          .filter(label => !before.labelIds.includes(label))
          .map(label => ({ kind: 'labels' as const, text: `added label ${labelById(label)?.name ?? label}` })),
        ...before.labelIds
          .filter(label => !after.labelIds.includes(label))
          .map(label => ({ kind: 'labels' as const, text: `removed label ${labelById(label)?.name ?? label}` })),
        ...(before.title === after.title ? [] : [{ kind: 'title' as const, text: `changed the title to "${after.title}"` }]),
        ...(before.description === after.description ? [] : [{ kind: 'description' as const, text: 'updated the description' }]),
      ]

      return {
        current: SubscriptionRef.get(state),
        changes: SubscriptionRef.changes(state),
        memberFor: name =>
          Effect.gen(function* () {
            const wanted = name.trim().toLowerCase()
            const find = (members: ReadonlyArray<Member>) =>
              members.find(member => member.name.toLowerCase() === wanted || member.name.split(' ')[0]?.toLowerCase() === wanted)
            // Known names change nothing (no new version, no re-render anywhere).
            const known = find((yield* SubscriptionRef.get(state)).members)
            if (known !== undefined) return known
            return yield* modify(current => {
            const existing = find(current.members)
            if (existing !== undefined) return Effect.succeed([existing, current] as const)
            const slug = wanted.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'member'
            const taken = new Set(current.members.map(member => member.id))
            let memberId = slug
            for (let suffix = 2; taken.has(memberId); suffix += 1) memberId = `${slug}-${suffix}`
            const member: Member = {
              id: memberId,
              name: name.trim(),
              color: AVATAR_COLORS[current.members.length % AVATAR_COLORS.length] ?? 'bg-slate-500',
              isDark: false,
            }
            return Effect.succeed([member, { ...current, members: [...current.members, member] }] as const)
            })
          }),
        create: (input, actorId) =>
          modify((current, at) =>
            checkPatch(current, input).pipe(
              Effect.map(() => {
                counters[input.team] += 1
                const number = counters[input.team]
                const issue: Issue = {
                  id: id('iss'),
                  team: input.team,
                  number,
                  identifier: `${input.team}-${number}`,
                  title: input.title,
                  description: input.description,
                  status: input.status,
                  priority: input.priority,
                  assigneeId: input.assigneeId,
                  labelIds: input.labelIds,
                  creatorId: actorId,
                  createdAt: at,
                  updatedAt: at,
                }
                const created: Activity = { id: id('a'), issueId: issue.id, actorId, kind: 'created', text: 'created the issue', at }
                return [issue, { ...current, issues: [...current.issues, issue], activity: [...current.activity, created] }] as const
              }),
            ),
          ),
        update: (changes, actorId) =>
          modify((current, at) =>
            Effect.gen(function* () {
              for (const change of changes) yield* checkPatch(current, change.patch)
              const missing = changes.map(change => change.id).find(issueId => !current.issues.some(issue => issue.id === issueId))
              if (missing !== undefined) return yield* new IssueNotFound({ id: missing })
              const entries: Array<Activity> = []
              const issues = current.issues.map(issue => {
                const patch = changes.find(change => change.id === issue.id)?.patch
                if (patch === undefined) return issue
                const next: Issue = { ...issue, ...patch, updatedAt: at }
                const described = describe(current.members, issue, next)
                if (described.length === 0) return issue
                for (const entry of described) entries.push({ id: id('a'), issueId: issue.id, actorId, at, ...entry })
                return next
              })
              return [undefined, { ...current, issues, activity: [...current.activity, ...entries] }] as const
            }),
          ),
        comment: (issueId, body, authorId) =>
          modify((current, at) => {
            if (!current.issues.some(issue => issue.id === issueId)) return Effect.fail(new IssueNotFound({ id: issueId }))
            const comment: Comment = { id: id('c'), issueId, authorId, body, createdAt: at }
            return Effect.succeed([comment, { ...current, comments: [...current.comments, comment] }] as const)
          }),
        setTheme: (memberId, isDark) =>
          modify(current =>
            Effect.succeed([
              undefined,
              { ...current, members: current.members.map(member => (member.id === memberId ? { ...member, isDark } : member)) },
            ] as const),
          ),
        remove: issueId =>
          modify(current =>
            current.issues.some(issue => issue.id === issueId)
              ? Effect.succeed([
                  undefined,
                  {
                    ...current,
                    issues: current.issues.filter(issue => issue.id !== issueId),
                    comments: current.comments.filter(comment => comment.issueId !== issueId),
                    activity: current.activity.filter(entry => entry.issueId !== issueId),
                  },
                ] as const)
              : Effect.fail(new IssueNotFound({ id: issueId })),
          ),
      }
    }),
  )
}

/** Who is looking at which issue. Joining is a scoped resource: a viewer is
 *  listed exactly as long as their page's live connection is open. */
export class Viewers extends Context.Service<
  Viewers,
  {
    readonly join: (issueId: string, memberId: string) => Effect.Effect<void, never, Scope.Scope>
    /** Member ids viewing the issue, at once and on every change. */
    readonly of: (issueId: string) => Stream.Stream<ReadonlyArray<string>>
  }
>()('linear/Viewers') {
  static readonly layer = Layer.effect(
    Viewers,
    Effect.gen(function* () {
      type Entry = Readonly<{ key: number; issueId: string; memberId: string }>
      const entries = yield* SubscriptionRef.make<ReadonlyArray<Entry>>([])
      let nextKey = 1
      return {
        join: (issueId, memberId) =>
          Effect.acquireRelease(
            Effect.sync(() => nextKey++).pipe(
              Effect.tap(key => SubscriptionRef.update(entries, list => [...list, { key, issueId, memberId }])),
            ),
            key => SubscriptionRef.update(entries, list => list.filter(entry => entry.key !== key)),
          ).pipe(Effect.asVoid),
        of: issueId =>
          SubscriptionRef.changes(entries).pipe(
            Stream.map(list => [...new Set(list.filter(entry => entry.issueId === issueId).map(entry => entry.memberId))].sort()),
            Stream.changesWith((a, b) => a.length === b.length && a.every((value, index) => value === b[index])),
          ),
      }
    }),
  )
}

export const layer = Layer.mergeAll(Workspace.layer, Viewers.layer)
