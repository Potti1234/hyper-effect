import { Duration, Effect, Layer, Schedule } from 'effect'
import { KeyValueStore } from 'effect/persistence'
import { SqlClient } from 'effect/sql'

/* Session snapshots in a SQL database, for processes on several machines.
   Any `SqlClient` will do (Postgres, SQLite, MySQL with its own upsert left
   out); the app provides the driver.

   - Writes are one upsert, so a reader finds the old snapshot or the new one.
   - Every row expires `ttl` after its last write: an expired row is never
     read, and a purge deletes expired rows every `purgeEvery`. A live session
     rewrites its snapshot before then (see `snapshotTtl`); rows that expire
     are those of sessions whose process failed before closing them, which no
     one else would delete. */

export type SqlStoreOptions = Readonly<{
  /** Table name; created if missing. */
  table?: string
  /** How long a row lives after its last write. Match `snapshotTtl`. */
  ttl?: Duration.Input
  /** How often expired rows are deleted. */
  purgeEvery?: Duration.Input
}>

export const sqlStore = (options: SqlStoreOptions = {}) =>
  Layer.effect(KeyValueStore.KeyValueStore)(
    Effect.gen(function* () {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms()
      const table = sql(options.table ?? 'hyper_snapshots')
      const ttl = Duration.toMillis(Duration.fromInputUnsafe(options.ttl ?? '1 day'))
      yield* sql`
        CREATE TABLE IF NOT EXISTS ${table} (
          id TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          expires_at BIGINT NOT NULL
        )
      `.pipe(Effect.orDie)

      const failed = (method: string, key?: string) => (cause: unknown) =>
        new KeyValueStore.KeyValueStoreError({
          method,
          ...(key === undefined ? {} : { key }),
          message: `Unable to ${method}${key === undefined ? '' : ` item with key ${key}`}`,
          cause,
        })
      // Statements capture their parameters when built: anything reading the
      // clock is built per run.
      const get = (key: string) =>
        sql<{ value: string }>`SELECT value FROM ${table} WHERE id = ${key} AND expires_at > ${Date.now()}`.pipe(
          Effect.map(rows => rows[0]?.value),
          Effect.mapError(failed('get', key)),
        )

      // Expired rows of sessions no live process will close.
      yield* Effect.suspend(() => sql`DELETE FROM ${table} WHERE expires_at <= ${Date.now()}`).pipe(
        Effect.ignore,
        Effect.repeat(Schedule.spaced(options.purgeEvery ?? '1 minute')),
        Effect.forkScoped,
      )

      return KeyValueStore.make({
        get,
        getUint8Array: key =>
          get(key).pipe(Effect.map(value => (value === undefined ? undefined : new TextEncoder().encode(value)))),
        set: (key, value) =>
          Effect.suspend(() => sql`
            INSERT INTO ${table} (id, value, expires_at)
            VALUES (${key}, ${typeof value === 'string' ? value : new TextDecoder().decode(value)}, ${Date.now() + ttl})
            ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
          `).pipe(Effect.asVoid, Effect.mapError(failed('set', key))),
        remove: key => sql`DELETE FROM ${table} WHERE id = ${key}`.pipe(Effect.asVoid, Effect.mapError(failed('remove', key))),
        clear: sql`DELETE FROM ${table}`.pipe(Effect.asVoid, Effect.mapError(failed('clear'))),
        size: Effect.suspend(
          () => sql<{ count: string | number }>`SELECT COUNT(*) AS count FROM ${table} WHERE expires_at > ${Date.now()}`,
        ).pipe(
          Effect.map(rows => Number(rows[0]?.count ?? 0)),
          Effect.mapError(failed('size')),
        ),
      })
    }),
  )
