import { Schema as S, SchemaIssue } from 'effect'

/* The catalog: products with a SKU, price, stock, status and an image. */

export const Categories = ['Tools', 'Garden', 'Kitchen', 'Lighting', 'Office', 'Outdoor'] as const
export const Category = S.Literals(Categories)
export type Category = typeof Category.Type

export const Statuses = ['active', 'draft', 'archived'] as const
export const Status = S.Literals(Statuses)
export type Status = typeof Status.Type

export const statusLabel: Readonly<Record<Status, string>> = {
  active: 'Active',
  draft: 'Draft',
  archived: 'Archived',
}

/** An uploaded image: the bytes live in the image store, the product keeps
 *  the reference. */
export const ImageRef = S.Struct({ id: S.String, name: S.String, type: S.String, size: S.Number })
export type ImageRef = typeof ImageRef.Type

export const Product = S.Struct({
  id: S.String,
  sku: S.String,
  name: S.String,
  category: Category,
  /** In cents. */
  price: S.Number,
  stock: S.Number,
  status: Status,
  description: S.String,
  image: S.NullOr(ImageRef),
  updatedAt: S.Number,
  updatedBy: S.String,
  /** Bumped on every change, for edit conflicts. */
  revision: S.Number,
})
export type Product = typeof Product.Type

// FORM

/** The form as typed: every field a string, as inputs hold them. */
export const Draft = S.Struct({
  sku: S.String,
  name: S.String,
  category: S.String,
  price: S.String,
  stock: S.String,
  status: S.String,
  description: S.String,
})
export type Draft = typeof Draft.Type

const oneOf = (values: ReadonlyArray<string>, message: string) =>
  S.makeFilter((value: string) => values.includes(value), { message })

/** What a valid form must hold; the messages are shown next to the fields.
 *  Field names match `Draft`, so errors map back onto the inputs. */
export const ProductInput = S.Struct({
  sku: S.String.pipe(
    S.check(S.isPattern(/^[A-Z]{3}-\d{4}$/, { message: 'Three capital letters, a dash and four digits, like TLS-0042.' })),
  ),
  name: S.String.pipe(
    S.check(
      S.isMinLength(2, { message: 'At least 2 characters.' }),
      S.isMaxLength(80, { message: 'At most 80 characters.' }),
    ),
  ),
  category: S.String.pipe(S.check(oneOf(Categories, 'Choose a category.'))),
  price: S.String.pipe(S.check(S.isPattern(/^\d{1,6}(\.\d{1,2})?$/, { message: 'A price like 12.50.' }))),
  stock: S.String.pipe(S.check(S.isPattern(/^\d{1,6}$/, { message: 'A whole number, 0 or more.' }))),
  status: S.String.pipe(S.check(oneOf(Statuses, 'Choose a status.'))),
  description: S.String.pipe(S.check(S.isMaxLength(2000, { message: 'At most 2000 characters.' }))),
})
export type ProductInput = typeof ProductInput.Type

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

/** Field errors keyed by the first path segment ('' for the whole value). */
export const fieldErrors = (issue: SchemaIssue.Issue): Readonly<Record<string, string>> => {
  const errors: Record<string, string> = {}
  for (const { path, message } of formatIssues(issue).issues) {
    const first = path?.[0]
    const field = first === undefined ? '' : String(typeof first === 'object' ? first.key : first)
    errors[field] ??= message
  }
  return errors
}

const decodeInput = S.decodeUnknownExit(ProductInput)

/** The form's input, or its field errors. Names are trimmed first. */
export const validateDraft = (
  draft: Draft,
): Readonly<{ _tag: 'Valid'; input: ProductInput }> | Readonly<{ _tag: 'Invalid'; errors: Readonly<Record<string, string>> }> => {
  const decoded = decodeInput({ ...draft, name: draft.name.trim(), sku: draft.sku.trim() }, { errors: 'all' })
  if (decoded._tag === 'Success') return { _tag: 'Valid', input: decoded.value }
  const error = decoded.cause.reasons.find(reason => reason._tag === 'Fail')?.error
  return { _tag: 'Invalid', errors: S.isSchemaError(error) ? fieldErrors(error.issue) : { '': 'Check the form.' } }
}

export const priceToCents = (price: string): number => Math.round(Number(price) * 100)

// Made once: a NumberFormat costs far more to create than to use, and every
// list render formats twenty prices.
const euros = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' })

export const formatPrice = (cents: number): string => euros.format(cents / 100)

export const draftOf = (product: Product): Draft => ({
  sku: product.sku,
  name: product.name,
  category: product.category,
  price: (product.price / 100).toFixed(2),
  stock: String(product.stock),
  status: product.status,
  description: product.description,
})

export const emptyDraft: Draft = {
  sku: '',
  name: '',
  category: '',
  price: '',
  stock: '0',
  status: 'draft',
  description: '',
}

// LIST QUERIES

export const SortColumn = S.Literals(['name', 'sku', 'price', 'stock', 'updatedAt'])
export type SortColumn = typeof SortColumn.Type

export const Query = S.Struct({
  search: S.String,
  category: S.String,
  status: S.String,
  sort: SortColumn,
  descending: S.Boolean,
  page: S.Number,
})
export type Query = typeof Query.Type

export const PAGE_SIZE = 20

export const defaultQuery: Query = {
  search: '',
  category: '',
  status: '',
  sort: 'updatedAt',
  descending: true,
  page: 1,
}

const decodeSort = S.decodeUnknownOption(SortColumn)

/** The query a list URL describes; unknown values fall back to defaults. */
export const queryFromUrl = (url: URL): Query => {
  const params = url.searchParams
  const page = Number(params.get('page') ?? '1')
  const sort = decodeSort(params.get('sort'))
  return {
    search: (params.get('q') ?? '').slice(0, 100),
    category: Categories.find(category => category === params.get('category')) ?? '',
    status: Statuses.find(status => status === params.get('status')) ?? '',
    sort: sort._tag === 'Some' ? sort.value : defaultQuery.sort,
    descending: params.has('sort') ? params.get('dir') === 'desc' : defaultQuery.descending,
    page: Number.isInteger(page) && page > 0 ? page : 1,
  }
}

/** The list URL for a query, with defaults left out. */
export const urlForQuery = (query: Query): string => {
  const params = new URLSearchParams()
  if (query.search !== '') params.set('q', query.search)
  if (query.category !== '') params.set('category', query.category)
  if (query.status !== '') params.set('status', query.status)
  if (query.sort !== defaultQuery.sort || query.descending !== defaultQuery.descending) {
    params.set('sort', query.sort)
    params.set('dir', query.descending ? 'desc' : 'asc')
  }
  if (query.page > 1) params.set('page', String(query.page))
  const search = params.toString()
  return search === '' ? '/products' : `/products?${search}`
}

export const Page = S.Struct({ items: S.Array(Product), total: S.Number })
export type Page = typeof Page.Type
