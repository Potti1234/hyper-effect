import { Clock, Context, Data, Effect, Layer, Schema as S, Stream, SubscriptionRef } from 'effect'

/* The task store: the app's shared state, which every page shows live.

   In memory here, with a change feed: `changes` emits the current list at
   once and then every new one. Pages subscribe to it and get the data itself,
   so a change needs no extra query. A real app puts a database behind the
   same service and turns its change notifications (Postgres LISTEN/NOTIFY)
   into the same stream; see examples/admin/src/app/catalog/postgres.ts in the
   hyper-effect repository. */

export const Task = S.Struct({
  id: S.String,
  title: S.String,
  isDone: S.Boolean,
  createdBy: S.String,
  createdAt: S.Number,
})
export type Task = typeof Task.Type

export class TaskNotFound extends Data.TaggedError('TaskNotFound')<{ readonly id: string }> {}

export class Tasks extends Context.Service<
  Tasks,
  {
    readonly current: Effect.Effect<ReadonlyArray<Task>>
    /** The current list at once, then every new one. */
    readonly changes: Stream.Stream<ReadonlyArray<Task>>
    readonly add: (title: string, by: string) => Effect.Effect<Task>
    readonly toggle: (id: string) => Effect.Effect<Task, TaskNotFound>
    readonly remove: (id: string) => Effect.Effect<void, TaskNotFound>
  }
>()('app/Tasks') {
  static readonly layer = Layer.effect(
    Tasks,
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const tasks = yield* SubscriptionRef.make<ReadonlyArray<Task>>([
        { id: 't1', title: 'Read the README', isDone: true, createdBy: 'hyper-effect', createdAt: now },
        { id: 't2', title: 'Open this page in a second window', isDone: false, createdBy: 'hyper-effect', createdAt: now },
        { id: 't3', title: 'Add a task and watch it appear in both', isDone: false, createdBy: 'hyper-effect', createdAt: now },
      ])
      let nextId = 4

      const find = (id: string) =>
        Effect.flatMap(SubscriptionRef.get(tasks), list => {
          const task = list.find(item => item.id === id)
          return task === undefined ? Effect.fail(new TaskNotFound({ id })) : Effect.succeed(task)
        })

      return {
        current: SubscriptionRef.get(tasks),
        changes: SubscriptionRef.changes(tasks),
        add: (title, by) =>
          Effect.gen(function* () {
            const task: Task = {
              id: `t${nextId++}`,
              title,
              isDone: false,
              createdBy: by,
              createdAt: yield* Clock.currentTimeMillis,
            }
            yield* SubscriptionRef.update(tasks, list => [...list, task])
            return task
          }),
        toggle: id =>
          Effect.gen(function* () {
            const task = yield* find(id)
            const toggled = { ...task, isDone: !task.isDone }
            yield* SubscriptionRef.update(tasks, list => list.map(item => (item.id === id ? toggled : item)))
            return toggled
          }),
        remove: id =>
          Effect.gen(function* () {
            yield* find(id)
            yield* SubscriptionRef.update(tasks, list => list.filter(item => item.id !== id))
          }),
      }
    }),
  )
}
