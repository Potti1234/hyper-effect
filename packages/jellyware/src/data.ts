import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Effect, Schema as S, SubscriptionRef } from 'effect'

import type { Check } from './changes.ts'

/* Data of an extension: a SQLite database of its own (Node's `node:sqlite`),
   kept by the server in `<dataDirectory>/<id>.sqlite` across versions, undo
   and restarts (after bb, docs/jellyware/prior-art.md).

   Its tables come from migrations declared in extension.json
   (`"migrations": ["CREATE TABLE ...", ...]`), append-only: the statement
   at index n is migration n, its hash is recorded when it is applied, and a
   later version must declare the same statements in the same order before
   any new ones. The loader applies the new ones before it builds the
   extension; the run pipeline replays them first on a copy of the database
   (`migrationsCheck`), so a changed migration or one that fails goes back
   to the agent instead of going live.

   The extension reads and writes rows (`ExtensionData.query`, `run`) and
   follows its writes (`changes`). SQLite's authorizer keeps its statements
   to rows: no schema changes outside migrations, no `ATTACH` of other
   files, no `PRAGMA`, no writes to the table of applied migrations. */

export { DataError, DataSummary, ExtensionData, type Row, type SqlValue, SqlValueSchema } from './data-service.ts'
import { DataError, type DataSummary, ExtensionData } from './data-service.ts'

const MIGRATIONS = '_jellyware_migrations'

/** SQLite's authorizer codes (sqlite.org/c3ref/c_alter_table.html). */
const SQLITE = { OK: 0, DENY: 1, DELETE: 9, INSERT: 18, READ: 20, SELECT: 21, UPDATE: 23, FUNCTION: 31, RECURSIVE: 33 } as const

/** What node:sqlite has from Node 24 on, beyond the installed types;
 *  `enableDefensive` from Node 26. */
type Sqlite = DatabaseSync & {
  enableDefensive?: (on: boolean) => void
  setAuthorizer: (callback: ((action: number, first: string | null) => number) | null) => void
}
const isRecentSqlite = (db: DatabaseSync): db is Sqlite => 'setAuthorizer' in db
const recent = (db: DatabaseSync): Sqlite => {
  if (!isRecentSqlite(db)) throw new Error('Extension data needs node:sqlite with an authorizer (Node 24 or later).')
  return db
}

const hashOf = (statement: string) => createHash('sha256').update(statement).digest('hex')

const message = (error: unknown) =>
  typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error)

/** Applies the migrations a database lacks, in one transaction; answers
 *  with what is wrong, or null. Statements already applied must be the
 *  same; applied ones a version no longer declares (an undone run's) stay. */
export const applyMigrations = (db: DatabaseSync, statements: ReadonlyArray<string>): string | null => {
  db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS} (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, statement TEXT NOT NULL, applied_at INTEGER NOT NULL)`)
  const applied = new Map<number, string>()
  for (const row of db.prepare(`SELECT id, hash FROM ${MIGRATIONS} ORDER BY id`).all()) {
    applied.set(Number(row['id']), String(row['hash']))
  }
  for (const [index, statement] of statements.entries()) {
    const recorded = applied.get(index)
    if (recorded !== undefined && recorded !== hashOf(statement)) {
      return `Migration ${index} differs from the one applied before. Migrations are append-only: put it back as it was and add a new migration after the last one (index ${Math.max(...applied.keys()) + 1}).`
    }
  }
  const missing = statements.map((statement, index) => ({ statement, index })).filter(({ index }) => !applied.has(index))
  if (missing.length === 0) return null
  const firstNew = missing[0]?.index ?? 0
  if (applied.size > 0 && firstNew <= Math.max(...applied.keys())) {
    return `Migration ${firstNew} would fill a gap below the last applied one; add new migrations after index ${Math.max(...applied.keys())}.`
  }
  const record = db.prepare(`INSERT INTO ${MIGRATIONS} (id, hash, statement, applied_at) VALUES (?, ?, ?, ?)`)
  try {
    db.exec('BEGIN')
    for (const { statement, index } of missing) {
      try {
        db.exec(statement)
      } catch (error) {
        throw new Error(`Migration ${index} failed: ${message(error)}`)
      }
      record.run(index, hashOf(statement), statement, Date.now())
    }
    db.exec('COMMIT')
    return null
  } catch (error) {
    db.exec('ROLLBACK')
    return message(error)
  }
}

/** The tables of a database, with their columns. */
export const summarize = (db: DatabaseSync): DataSummary => {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != ? ORDER BY name")
    .all(MIGRATIONS)
    .map(row => String(row['name']))
  const migrations = Number(
    db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?`).get(MIGRATIONS)?.['n'] === 0
      ? 0
      : (db.prepare(`SELECT COUNT(*) AS n FROM ${MIGRATIONS}`).get()?.['n'] ?? 0),
  )
  return {
    migrations,
    tables: tables.map(name => ({
      name,
      columns: db.prepare(`SELECT name FROM pragma_table_info(?)`).all(name).map(row => String(row['name'])),
    })),
  }
}

/** What an extension's own statements may do: read and write rows of its
 *  tables, nothing else. */
const ALLOWED = new Set<number>([SQLITE.READ, SQLITE.SELECT, SQLITE.INSERT, SQLITE.UPDATE, SQLITE.DELETE, SQLITE.FUNCTION, SQLITE.RECURSIVE])
const authorizeRows = (action: number, first: string | null): number => {
  if (!ALLOWED.has(action)) return SQLITE.DENY
  const writes = action === SQLITE.INSERT || action === SQLITE.UPDATE || action === SQLITE.DELETE
  if (writes && (first === MIGRATIONS || (first ?? '').startsWith('sqlite_'))) return SQLITE.DENY
  return SQLITE.OK
}

/** An extension's database, open for the life of the server. */
export type Database = Readonly<{
  db: Sqlite
  version: SubscriptionRef.SubscriptionRef<number>
}>

export const openDatabase = (directory: string, id: string): Effect.Effect<Database> =>
  Effect.gen(function* () {
    mkdirSync(directory, { recursive: true })
    const db = recent(new DatabaseSync(join(directory, `${id}.sqlite`)))
    db.enableDefensive?.(true)
    return { db, version: yield* SubscriptionRef.make(0) }
  })

/** Runs `use` with the authorizer that keeps statements to rows. */
const asExtension = <A>(db: Sqlite, use: () => A): A => {
  db.setAuthorizer((action, first) => authorizeRows(action, first))
  try {
    return use()
  } finally {
    db.setAuthorizer(null)
  }
}

/** The service an extension gets for its database. */
export const makeData = (database: Database) =>
  ExtensionData.of({
    query: (sql, params = []) =>
      Effect.try({
        try: () => asExtension(database.db, () => database.db.prepare(sql).all(...params)),
        catch: error => new DataError({ message: message(error) }),
      }).pipe(Effect.map(rows => rows.map(row => ({ ...row })))),
    run: (sql, params = []) =>
      Effect.try({
        try: () => Number(asExtension(database.db, () => database.db.prepare(sql).run(...params)).changes),
        catch: error => new DataError({ message: message(error) }),
      }).pipe(Effect.tap(changed => (changed > 0 ? SubscriptionRef.update(database.version, n => n + 1) : Effect.void))),
    changes: SubscriptionRef.changes(database.version),
  })

const Migrations = S.Struct({ migrations: S.optional(S.Array(S.String)) })
const decodeMigrations = S.decodeUnknownEffect(S.fromJsonString(Migrations))

/** A run check: replays the migrations of each changed extension on a copy
 *  of its database (an empty one for a new extension), so a changed or
 *  failing migration goes back to the agent before anything goes live. */
export const migrationsCheck = (dataDirectory: string): Check => ({
  name: 'Migrations',
  run: ({ snapshot, runDirectory, changed }) =>
    Effect.gen(function* () {
      const problems: Array<string> = []
      for (const id of changed) {
        const text = yield* Effect.promise(() => readFile(join(snapshot, id, 'extension.json'), 'utf8').catch(() => null))
        if (text === null) continue
        const declared = (yield* decodeMigrations(text).pipe(Effect.orElseSucceed(() => ({ migrations: undefined })))).migrations ?? []
        if (declared.length === 0) continue
        // A consistent copy of the live database (VACUUM INTO), or none.
        const copyFile = join(runDirectory, `data-check-${id}.sqlite`)
        yield* Effect.promise(() => rm(copyFile, { force: true }))
        const live = join(dataDirectory, `${id}.sqlite`)
        if (existsSync(live)) {
          const source = new DatabaseSync(live, { readOnly: true })
          try {
            source.exec(`VACUUM INTO '${copyFile.replaceAll("'", "''")}'`)
          } finally {
            source.close()
          }
        }
        const copy = new DatabaseSync(copyFile)
        try {
          const problem = applyMigrations(copy, declared)
          if (problem !== null) problems.push(`${id}/extension.json: ${problem}`)
        } finally {
          copy.close()
          yield* Effect.promise(() => rm(copyFile, { force: true }))
        }
      }
      if (problems.length > 0) return yield* Effect.fail(problems.join('\n'))
    }),
})
