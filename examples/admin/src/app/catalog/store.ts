import { Clock, Context, Data, Effect, Layer, Stream, SubscriptionRef } from 'effect'

import {
  Categories,
  type Category,
  type ImageRef,
  PAGE_SIZE,
  type Page,
  type Product,
  type ProductInput,
  type Query,
  type Status,
  priceToCents,
} from './domain'

/* The catalog store: an in-memory table with a change feed, or Postgres with
   LISTEN/NOTIFY (`postgres.ts`) when several processes serve the admin. The
   pages only see this service. */

export class ProductNotFound extends Data.TaggedError('ProductNotFound')<{ readonly id: string }> {}

export class SkuTaken extends Data.TaggedError('SkuTaken')<{ readonly sku: string }> {}

/** The product changed since the editor loaded it. */
export class StaleRevision extends Data.TaggedError('StaleRevision')<{
  readonly current: Product
}> {}

export type Changes = Readonly<{
  input: ProductInput
  image: ImageRef | null
}>

export class Catalog extends Context.Service<
  Catalog,
  {
    readonly page: (query: Query) => Effect.Effect<Page>
    readonly find: (id: string) => Effect.Effect<Product, ProductNotFound>
    readonly create: (changes: Changes, by: string) => Effect.Effect<Product, SkuTaken>
    readonly update: (
      id: string,
      revision: number,
      changes: Changes,
      by: string,
    ) => Effect.Effect<Product, ProductNotFound | SkuTaken | StaleRevision>
    readonly remove: (id: string) => Effect.Effect<void, ProductNotFound>
    /** A number that changes with every write. */
    readonly changes: Stream.Stream<number>
  }
>()('admin/Catalog') {
  static readonly layer = Layer.effect(
    Catalog,
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const products = new Map(seed(now).map(product => [product.id, product]))
      const version = yield* SubscriptionRef.make(0)
      let nextId = products.size + 1
      const changed = SubscriptionRef.update(version, value => value + 1)

      const skuTaken = (sku: string, except: string | null) =>
        [...products.values()].some(product => product.sku === sku && product.id !== except)

      return {
        page: query =>
          Effect.sync(() => {
            const search = query.search.trim().toLowerCase()
            const matching = [...products.values()].filter(
              product =>
                (query.category === '' || product.category === query.category) &&
                (query.status === '' || product.status === query.status) &&
                (search === '' ||
                  product.name.toLowerCase().includes(search) ||
                  product.sku.toLowerCase().includes(search)),
            )
            const direction = query.descending ? -1 : 1
            matching.sort((a, b) => {
              const left = a[query.sort]
              const right = b[query.sort]
              const order =
                typeof left === 'number' && typeof right === 'number'
                  ? left - right
                  : String(left).localeCompare(String(right))
              return order === 0 ? a.id.localeCompare(b.id) : order * direction
            })
            const start = (query.page - 1) * PAGE_SIZE
            return { items: matching.slice(start, start + PAGE_SIZE), total: matching.length }
          }),
        find: id =>
          Effect.suspend(() => {
            const product = products.get(id)
            return product === undefined ? Effect.fail(new ProductNotFound({ id })) : Effect.succeed(product)
          }),
        create: (changes, by) =>
          Effect.gen(function* () {
            if (skuTaken(changes.input.sku, null)) return yield* new SkuTaken({ sku: changes.input.sku })
            const at = yield* Clock.currentTimeMillis
            const product: Product = {
              id: `P${String((nextId += 1)).padStart(4, '0')}`,
              ...fields(changes),
              updatedAt: at,
              updatedBy: by,
              revision: 1,
            }
            products.set(product.id, product)
            yield* changed
            return product
          }),
        update: (id, revision, changes, by) =>
          Effect.gen(function* () {
            const current = products.get(id)
            if (current === undefined) return yield* new ProductNotFound({ id })
            if (current.revision !== revision) return yield* new StaleRevision({ current })
            if (skuTaken(changes.input.sku, id)) return yield* new SkuTaken({ sku: changes.input.sku })
            const at = yield* Clock.currentTimeMillis
            const product: Product = {
              ...current,
              ...fields(changes),
              updatedAt: at,
              updatedBy: by,
              revision: current.revision + 1,
            }
            products.set(id, product)
            yield* changed
            return product
          }),
        remove: id =>
          Effect.gen(function* () {
            if (!products.delete(id)) return yield* new ProductNotFound({ id })
            yield* changed
          }),
        changes: SubscriptionRef.changes(version),
      }
    }),
  )
}

// SEED

const NOUNS: Readonly<Record<Category, ReadonlyArray<string>>> = {
  Tools: ['Hammer', 'Wrench', 'Screwdriver set', 'Spirit level', 'Hand saw', 'Pliers', 'Drill bits'],
  Garden: ['Rake', 'Watering can', 'Pruning shears', 'Hose reel', 'Seed tray', 'Trowel'],
  Kitchen: ['Chef knife', 'Cutting board', 'Saucepan', 'Whisk', 'Colander', 'Kettle'],
  Lighting: ['Desk lamp', 'LED strip', 'Pendant light', 'Floor lamp', 'Night light'],
  Office: ['Notebook', 'Stapler', 'Desk organizer', 'Monitor stand', 'Paper tray'],
  Outdoor: ['Camping chair', 'Cooler box', 'Lantern', 'Tarp', 'Hammock'],
}
const ADJECTIVES = ['Compact', 'Classic', 'Heavy-duty', 'Bamboo', 'Steel', 'Pro', 'Travel', 'Eco']
const PREFIX: Readonly<Record<Category, string>> = {
  Tools: 'TLS',
  Garden: 'GRD',
  Kitchen: 'KIT',
  Lighting: 'LGT',
  Office: 'OFC',
  Outdoor: 'OUT',
}

/** The stored fields of validated changes. */
export const fields = (changes: Changes) => ({
  sku: changes.input.sku,
  name: changes.input.name,
  /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
  category: changes.input.category as Category,
  price: priceToCents(changes.input.price),
  stock: Number(changes.input.stock),
  /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
  status: changes.input.status as Status,
  description: changes.input.description,
  image: changes.image,
})

/** 240 products, the same on every start. */
export const seed = (now: number): ReadonlyArray<Product> =>
  Array.from({ length: 240 }, (_, index) => {
    const category = Categories[index % Categories.length] ?? 'Tools'
    const nouns = NOUNS[category]
    const noun = nouns[Math.floor(index / Categories.length) % nouns.length] ?? 'Item'
    const adjective = ADJECTIVES[(index * 7) % ADJECTIVES.length] ?? ''
    const statuses: ReadonlyArray<Status> = ['active', 'active', 'active', 'draft', 'archived']
    return {
      id: `P${String(index + 1).padStart(4, '0')}`,
      sku: `${PREFIX[category]}-${String(1000 + index).padStart(4, '0')}`,
      name: `${adjective} ${noun.toLowerCase()}`,
      category,
      price: 299 + ((index * 1373) % 18000),
      stock: (index * 37) % 140,
      status: statuses[index % statuses.length] ?? 'active',
      description: '',
      image: null,
      updatedAt: now - index * 3_600_000,
      updatedBy: 'seed',
      revision: 1,
    }
  })
