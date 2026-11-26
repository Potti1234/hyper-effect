import { Context, Data, Schema as S, type Effect, type Stream } from 'effect'

/* What an extension sees of its database: the service and its types,
   without the SQLite implementation (data.ts), so that an extension's own
   process loads node:sqlite only through the server. */

export type SqlValue = string | number | bigint | null | Uint8Array

export const SqlValueSchema = S.Union([S.String, S.Number, S.BigInt, S.Null, S.Uint8Array])

export class DataError extends Data.TaggedError('DataError')<{ readonly message: string }> {}

export type Row = Readonly<Record<string, SqlValue>>

export class ExtensionData extends Context.Service<
  ExtensionData,
  {
    /** Rows of a `SELECT`, with `?` parameters. */
    readonly query: (sql: string, params?: ReadonlyArray<SqlValue>) => Effect.Effect<ReadonlyArray<Row>, DataError>
    /** An `INSERT`, `UPDATE` or `DELETE`; answers with the rows changed. */
    readonly run: (sql: string, params?: ReadonlyArray<SqlValue>) => Effect.Effect<number, DataError>
    /** A number that grows with every write of this extension, now and
     *  after each write (from any of its versions): query again on it. */
    readonly changes: Stream.Stream<number>
  }
>()('@hyper-effect/jellyware/ExtensionData') {}

/** What an extension's database holds, for the workshop and the guide. */
export const DataSummary = S.Struct({
  /** Applied migrations. */
  migrations: S.Number,
  tables: S.Array(S.Struct({ name: S.String, columns: S.Array(S.String) })),
})
export type DataSummary = typeof DataSummary.Type
