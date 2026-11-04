import { PgClient } from '@effect/sql-pg'
import { afterAll, assert, describe, it } from '@effect/vitest'
import { Context, Effect, Exit, Layer, Redacted, Scope } from 'effect'
import { KeyValueStore } from 'effect/persistence'
import { SqlClient } from 'effect/sql'

import { sqlStore } from '../src/sql-store'
import { openPage, openStream, postEvent, readUntil, serve, token } from '../src/testing'

import { program } from './fixtures/greeter'

/* Snapshots in Postgres (phase B5). Needs a database:
   HYPER_TEST_DATABASE_URL=$(bash tools/postgres/start.sh) npx vitest run sql-store
   Skipped without one. */

const url = process.env['HYPER_TEST_DATABASE_URL']

describe.skipIf(url === undefined)('sqlStore on Postgres', () => {
  const table = `hyper_test_${process.pid}`
  const pg = PgClient.layer({ url: Redacted.make(url ?? '') })
  const storeLayer = (options: Parameters<typeof sqlStore>[0] = {}) =>
    sqlStore({ table, ...options }).pipe(Layer.provideMerge(pg))
  const dropTable = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DROP TABLE IF EXISTS ${sql(table)}`
  }).pipe(Effect.provide(pg))
  afterAll(() => Effect.runPromise(dropTable))

  it.live('stores, replaces and removes values', () =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore
      yield* store.set('a', 'first')
      yield* store.set('a', 'second')
      assert.strictEqual(yield* store.get('a'), 'second')
      yield* store.remove('a')
      assert.isUndefined(yield* store.get('a'))
    }).pipe(Effect.provide(storeLayer())),
  )

  it.live('never reads an expired row, and purges it', () =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore
      const sql = yield* SqlClient.SqlClient
      yield* store.set('old', 'value')
      assert.strictEqual(yield* store.get('old'), 'value')
      yield* Effect.sleep('400 millis')
      assert.isUndefined(yield* store.get('old'), 'expired, still in the table')
      yield* Effect.sleep('400 millis')
      const rows = yield* sql<{ id: string }>`SELECT id FROM ${sql(table)} WHERE id = 'old'`
      assert.strictEqual(rows.length, 0, 'purged')
    }).pipe(Effect.provide(storeLayer({ ttl: '300 millis', purgeEvery: '200 millis' }))),
  )

  it('carries a session from one process to another, losing no answered event', async () => {
    const scope = Effect.runSync(Scope.make())
    const context = await Effect.runPromise(
      Layer.buildWithScope(Layer.provide(sqlStore({ table }), pg), scope),
    )
    const store = Context.make(KeyValueStore.KeyValueStore, Context.get(context, KeyValueStore.KeyValueStore))
    const served = { ...program, name: 'sqlstore' }
    const w1 = serve(served, { node: 'w1' }, store)
    const w2 = serve(served, { node: 'w2' }, store)
    try {
      const page = await openPage(w1.handler)
      assert.strictEqual((await postEvent(w1.handler, page, { m: token({ _tag: 'ClickedIncrement' }), q: 1 })).status, 204)
      const text = await readUntil(await openStream(w2.handler, page), '</title>')
      assert.match(text, /hyper-effect \(1\)/)
    } finally {
      await Promise.all([w1.dispose(), w2.dispose()])
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  })
})
