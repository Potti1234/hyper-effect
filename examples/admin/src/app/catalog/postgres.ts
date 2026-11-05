import { PgClient } from '@effect/sql-pg'
import { Array as Arr, Clock, Effect, Layer, Option, Queue, SubscriptionRef } from 'effect'
import { SqlClient } from 'effect/sql'

import { type Product, PAGE_SIZE, type SortColumn } from './domain'
import { Images, accept, refOf } from './images'
import { Catalog, ProductNotFound, SkuTaken, StaleRevision, fields, seed } from './store'

/* The catalog and its images in Postgres, for several processes serving the
   admin (phase B5): the reference for app state across nodes.

   - Every write runs in a transaction with `pg_notify('catalog_changes')`,
     which Postgres delivers on commit, to every process.
   - Each process listens once and turns notifications into the version the
     pages' Subscriptions watch, as the in-memory store does.
   - Edit conflicts are a conditional UPDATE on the revision; a taken SKU is
     the unique constraint.
   Database failures are defects here: the pages have no way to recover from
   a lost database, and the errors stay in the logs. */

const CHANNEL = 'catalog_changes'

type Row = Readonly<{
  id: string
  sku: string
  name: string
  category: string
  price: number
  stock: number
  status: string
  description: string
  image: Product['image']
  updated_at: string | number
  updated_by: string
  revision: number
}>

const toProduct = (row: Row): Product =>
  /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
  ({
    id: row.id,
    sku: row.sku,
    name: row.name,
    category: row.category,
    price: row.price,
    stock: row.stock,
    status: row.status,
    description: row.description,
    image: row.image,
    updatedAt: Number(row.updated_at),
    updatedBy: row.updated_by,
    revision: row.revision,
  }) as Product

const COLUMNS: Readonly<Record<SortColumn, string>> = {
  name: 'name',
  sku: 'sku',
  price: 'price',
  stock: 'stock',
  updatedAt: 'updated_at',
}

/** Whether a failed statement broke a unique constraint (Postgres code
 *  23505), looking through the error's causes to the driver's error. */
const isUniqueViolation = (error: unknown): boolean => {
  let current = error
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    if ((current as { code?: unknown }).code === '23505') return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

export const catalogLayer = Layer.effect(
  Catalog,
  Effect.gen(function* () {
    const sql = (yield* SqlClient.SqlClient).withoutTransforms()
    const pg = yield* PgClient.PgClient

    yield* sql.withTransaction(
      Effect.gen(function* () {
        // One process creates and seeds; the others wait for it.
        yield* sql`SELECT pg_advisory_xact_lock(4242)`
        yield* sql`
          CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY,
            sku TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            category TEXT NOT NULL,
            price INTEGER NOT NULL,
            stock INTEGER NOT NULL,
            status TEXT NOT NULL,
            description TEXT NOT NULL,
            image JSONB,
            updated_at BIGINT NOT NULL,
            updated_by TEXT NOT NULL,
            revision INTEGER NOT NULL
          )`
        yield* sql`CREATE SEQUENCE IF NOT EXISTS product_ids START 241`
        const [existing] = yield* sql<{ count: string }>`SELECT COUNT(*) AS count FROM products`
        if (Number(existing?.count ?? 0) === 0) {
          const now = yield* Clock.currentTimeMillis
          const rows = seed(now).map(product => ({
            id: product.id,
            sku: product.sku,
            name: product.name,
            category: product.category,
            price: product.price,
            stock: product.stock,
            status: product.status,
            description: product.description,
            image: null,
            updated_at: product.updatedAt,
            updated_by: product.updatedBy,
            revision: product.revision,
          }))
          if (Arr.isArrayNonEmpty(rows)) {
            yield* sql`INSERT INTO products ${sql.insert(rows)}`
          }
        }
      }),
    ).pipe(Effect.orDie)

    // The change feed: one listener per process.
    const version = yield* SubscriptionRef.make(0)
    const notifications = yield* pg.listen(CHANNEL).pipe(Effect.orDie)
    yield* Queue.take(notifications).pipe(
      Effect.andThen(SubscriptionRef.update(version, value => value + 1)),
      Effect.forever,
      Effect.forkScoped,
    )

    /** Runs a write and announces it, in one transaction. */
    const write = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      sql.withTransaction(Effect.tap(effect, () => sql`SELECT pg_notify(${CHANNEL}, '')`))

    const find = (id: string) =>
      sql<Row>`SELECT * FROM products WHERE id = ${id}`.pipe(
        Effect.orDie,
        Effect.flatMap(([row]) =>
          row === undefined ? Effect.fail(new ProductNotFound({ id })) : Effect.succeed(toProduct(row)),
        ),
      )

    return {
      page: query =>
        Effect.gen(function* () {
          const search = `%${query.search.trim().toLowerCase()}%`
          const where = sql.and([
            query.category === '' ? sql`TRUE` : sql`category = ${query.category}`,
            query.status === '' ? sql`TRUE` : sql`status = ${query.status}`,
            query.search.trim() === '' ? sql`TRUE` : sql`(lower(name) LIKE ${search} OR lower(sku) LIKE ${search})`,
          ])
          const order = sql.literal(`${COLUMNS[query.sort]} ${query.descending ? 'DESC' : 'ASC'}, id ASC`)
          const rows = yield* sql<Row>`
            SELECT * FROM products WHERE ${where} ORDER BY ${order}
            LIMIT ${PAGE_SIZE} OFFSET ${(query.page - 1) * PAGE_SIZE}`
          const [total] = yield* sql<{ count: string }>`SELECT COUNT(*) AS count FROM products WHERE ${where}`
          return { items: rows.map(toProduct), total: Number(total?.count ?? 0) }
        }).pipe(Effect.orDie),
      find,
      create: (changes, by) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          const stored = fields(changes)
          const [row] = yield* write(
            sql<Row>`
              INSERT INTO products (id, sku, name, category, price, stock, status, description, image, updated_at, updated_by, revision)
              VALUES ('P' || lpad(nextval('product_ids')::text, 4, '0'), ${stored.sku}, ${stored.name}, ${stored.category},
                ${stored.price}, ${stored.stock}, ${stored.status}, ${stored.description},
                ${stored.image === null ? null : JSON.stringify(stored.image)}::jsonb, ${at}, ${by}, 1)
              RETURNING *`,
          ).pipe(
            Effect.catch(error =>
              isUniqueViolation(error) ? Effect.fail(new SkuTaken({ sku: stored.sku })) : Effect.die(error),
            ),
          )
          return toProduct(row as Row)
        }),
      update: (id, revision, changes, by) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          const stored = fields(changes)
          const rows = yield* write(
            sql<Row>`
              UPDATE products SET sku = ${stored.sku}, name = ${stored.name}, category = ${stored.category},
                price = ${stored.price}, stock = ${stored.stock}, status = ${stored.status},
                description = ${stored.description},
                image = ${stored.image === null ? null : JSON.stringify(stored.image)}::jsonb,
                updated_at = ${at}, updated_by = ${by}, revision = revision + 1
              WHERE id = ${id} AND revision = ${revision}
              RETURNING *`,
          ).pipe(
            Effect.catch(error =>
              isUniqueViolation(error) ? Effect.fail(new SkuTaken({ sku: stored.sku })) : Effect.die(error),
            ),
          )
          const [row] = rows
          if (row !== undefined) return toProduct(row)
          // Nothing updated: gone, or changed since the editor loaded it.
          const current = yield* find(id)
          return yield* new StaleRevision({ current })
        }),
      remove: id =>
        write(sql<{ id: string }>`DELETE FROM products WHERE id = ${id} RETURNING id`).pipe(
          Effect.orDie,
          Effect.flatMap(rows => (rows.length === 0 ? Effect.fail(new ProductNotFound({ id })) : Effect.void)),
        ),
      changes: SubscriptionRef.changes(version),
    }
  }),
)

export const imagesLayer = Layer.effect(
  Images,
  Effect.gen(function* () {
    const sql = (yield* SqlClient.SqlClient).withoutTransforms()
    yield* sql`CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, type TEXT NOT NULL, bytes BYTEA NOT NULL)`.pipe(
      Effect.orDie,
    )
    return {
      put: file =>
        Effect.gen(function* () {
          const stored = yield* accept(file)
          const id = crypto.randomUUID()
          yield* sql`INSERT INTO images (id, type, bytes) VALUES (${id}, ${stored.type}, ${stored.bytes})`.pipe(
            Effect.orDie,
          )
          return refOf(id, file, stored)
        }),
      get: id =>
        sql<{ type: string; bytes: Uint8Array }>`SELECT type, bytes FROM images WHERE id = ${id}`.pipe(
          Effect.orDie,
          Effect.map(([row]) =>
            Option.fromNullishOr(row).pipe(Option.map(({ type, bytes }) => ({ type, bytes: new Uint8Array(bytes) }))),
          ),
        ),
    }
  }),
)

/** Both stores on Postgres, with the change feed. */
export const layer = Layer.mergeAll(catalogLayer, imagesLayer)
