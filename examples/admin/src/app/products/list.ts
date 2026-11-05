import { Effect, Match as M, Schema as S, Stream } from 'effect'
import { Command, Subscription, type Update } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import * as Navigation from 'foldkit/navigation'

import { type Program, region } from '@hyper-effect/core'

import { cn } from '@/lib/utils'
import { empty, emptyDescription, emptyTitle } from '@/ui/empty'
import { input } from '@/ui/input'
import { nativeSelect } from '@/ui/native-select'
import { paginationPages } from '@/ui/pagination'
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from '@/ui/table'

import { User, canEdit, requireUser } from '../auth'
import {
  Categories,
  PAGE_SIZE,
  Page,
  type Product,
  Query,
  SortColumn,
  Statuses,
  formatPrice,
  queryFromUrl,
  statusLabel,
  urlForQuery,
} from '../catalog/domain'
import { Catalog } from '../catalog/store'
import { HEADER_ID, formatDate, header, linkButton, statusBadge } from '../layout'

/* The product list: search, filters, sorting and pagination, all in-page.
   The query lives in the Model and is mirrored into the address bar
   (`ReplaceUrl`), so a list can be shared and reloaded; Flags read it back
   from the URL. Changes other admins make show up live. */

// MODEL

export const Model = S.Struct({
  user: User,
  /** The query the user asked for: the toolbar shows it. */
  query: Query,
  /** The page on screen, and the query it answers: the table, sort arrows
   *  and pager show these, so they never disagree while a page loads. */
  page: Page,
  shownQuery: Query,
  isLoading: S.Boolean,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ChangedSearch: { search: S.String },
  ChangedCategory: { category: S.String },
  ChangedStatus: { status: S.String },
  ClickedSort: { column: SortColumn },
  ClickedPage: { page: S.Number },
  GotPage: { query: Query, page: Page },
  ChangedCatalog: {},
  CompletedReplaceUrl: {},
})
export type Message = typeof Message.Type

/** Posted by the page as tokens; the rest come from handlers or the server. */
export const ClientMessage = S.Union([Message.ClickedSort, Message.ClickedPage])
export type ClientMessage = typeof ClientMessage.Type

// COMMAND

export const LoadPage = Command.define('LoadPage', {
  args: { query: Query },
  messages: [Message.GotPage],
  execute: ({ query }) =>
    Catalog.use(catalog => catalog.page(query)).pipe(Effect.map(page => Message.GotPage({ query, page }))),
})

/** In a browser this runs Foldkit's `Navigation.replaceUrl`; on the server it
 *  is forwarded to the page (see `clientCommands` below). */
export const ReplaceUrl = Command.define('ReplaceUrl', {
  args: { url: S.String },
  messages: [Message.CompletedReplaceUrl],
  execute: ({ url }) => Navigation.replaceUrl(url).pipe(Effect.as(Message.CompletedReplaceUrl())),
})

// INIT

export type Flags = Readonly<{ user: User; query: Query; page: Page }>

export const init = (flags: Flags): Update.Return<Model, Message> => ({
  model: { ...flags, shownQuery: flags.query, isLoading: false },
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Catalog>

const withQuery = (model: Model, query: Query): UpdateReturn => ({
  model: { ...model, query, isLoading: true },
  commands: [LoadPage({ query }), ReplaceUrl({ url: urlForQuery(query) })],
})

const sameQuery = (a: Query, b: Query): boolean =>
  a.search === b.search &&
  a.category === b.category &&
  a.status === b.status &&
  a.sort === b.sort &&
  a.descending === b.descending &&
  a.page === b.page

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ChangedSearch: ({ search }) => withQuery(model, { ...model.query, search, page: 1 }),
      ChangedCategory: ({ category }) => withQuery(model, { ...model.query, category, page: 1 }),
      ChangedStatus: ({ status }) => withQuery(model, { ...model.query, status, page: 1 }),
      ClickedSort: ({ column }) =>
        withQuery(model, {
          ...model.query,
          sort: column,
          // The same column flips; a new one starts ascending, except dates.
          descending: column === model.query.sort ? !model.query.descending : column === 'updatedAt',
          page: 1,
        }),
      ClickedPage: ({ page }) => withQuery(model, { ...model.query, page }),
      // Only the answer to the current query counts; older ones arrive late.
      GotPage: ({ query, page }) =>
        sameQuery(query, model.query) ? { model: { ...model, page, shownQuery: query, isLoading: false } } : { model },
      ChangedCatalog: () => ({ model, commands: [LoadPage({ query: model.query })] }),
      CompletedReplaceUrl: () => ({ model }),
    }),
  )

// SUBSCRIPTION

export const subscriptions = Subscription.make<Model, Message, Catalog>()(entry => ({
  catalog: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Stream.unwrap(
          Catalog.use(catalog =>
            Effect.succeed(
              // The first value is the current state, which the page has.
              catalog.changes.pipe(Stream.drop(1), Stream.map(() => Message.ChangedCatalog())),
            ),
          ),
        ),
    },
  ),
}))

// VIEW

const toolbar = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Id('toolbar'), h.Class('flex flex-wrap items-end gap-3')],
    [
      h.div(
        [h.Class('min-w-56 flex-1')],
        [
          input(
            {
              id: 'search',
              label: 'Search',
              value: model.query.search,
              placeholder: 'Name or SKU',
              onInput: search => Message.ChangedSearch({ search }),
            },
            h,
          ),
        ],
      ),
      nativeSelect(
        {
          id: 'category',
          label: 'Category',
          value: model.query.category,
          onChange: category => Message.ChangedCategory({ category }),
          options: [{ value: '', label: 'All categories' }, ...Categories.map(value => ({ value, label: value }))],
        },
        h,
      ),
      nativeSelect(
        {
          id: 'status',
          label: 'Status',
          value: model.query.status,
          onChange: status => Message.ChangedStatus({ status }),
          options: [{ value: '', label: 'Any status' }, ...Statuses.map(value => ({ value, label: statusLabel[value] }))],
        },
        h,
      ),
      ...(canEdit(model.user) ? [linkButton({ href: '/products/new', label: 'New product' }, h)] : []),
    ],
  )

const COLUMNS: ReadonlyArray<Readonly<{ column: SortColumn | null; label: string; class?: string }>> = [
  { column: 'name', label: 'Name' },
  { column: 'sku', label: 'SKU' },
  { column: null, label: 'Category' },
  { column: 'price', label: 'Price', class: 'text-right' },
  { column: 'stock', label: 'Stock', class: 'text-right' },
  { column: null, label: 'Status' },
  { column: 'updatedAt', label: 'Updated' },
]

const columnHead = (model: Model, h: HtmlBuilder<Message>) => (column: (typeof COLUMNS)[number]) => {
  const sorted = column.column !== null && column.column === model.shownQuery.sort
  return tableHead(
    {
      ...(column.class === undefined ? {} : { class: column.class }),
      children: [
        column.column === null
          ? column.label
          : h.button(
              [
                h.Type('button'),
                h.Class('inline-flex items-center gap-1 hover:underline'),
                h.AriaLabel(`Sort by ${column.label.toLowerCase()}`),
                h.OnClick(Message.ClickedSort({ column: column.column })),
              ],
              [column.label, sorted ? (model.shownQuery.descending ? ' ↓' : ' ↑') : ''],
            ),
      ],
    },
    h,
  )
}

const productRow = (product: Product, h: HtmlBuilder<Message>): Html =>
  tableRow(
    {
      id: `product-${product.id}`,
      children: [
        tableCell(
          {
            children: [
              h.a([h.Href(`/products/${product.id}`), h.Class('font-medium hover:underline')], [product.name]),
            ],
          },
          h,
        ),
        tableCell({ class: 'font-mono text-xs', children: [product.sku] }, h),
        tableCell({ children: [product.category] }, h),
        tableCell({ class: 'text-right tabular-nums', children: [formatPrice(product.price)] }, h),
        tableCell({ class: cn('text-right tabular-nums', product.stock === 0 && 'text-destructive'), children: [String(product.stock)] }, h),
        tableCell({ children: [statusBadge(product.status, h)] }, h),
        tableCell({ class: 'text-xs text-muted-foreground', children: [`${formatDate(product.updatedAt)} · ${product.updatedBy}`] }, h),
      ],
    },
    h,
  )

const results = (model: Model, h: HtmlBuilder<Message>): Html =>
  model.page.items.length === 0
    ? h.div(
        [h.Id('results')],
        [
          empty(
            { children: [emptyTitle({ children: ['No products'] }, h), emptyDescription({ children: ['Nothing matches these filters.'] }, h)] },
            h,
          ),
        ],
      )
    : table(
        {
          id: 'results',
          class: cn(model.isLoading && 'opacity-60'),
          children: [
            tableHeader({ children: [tableRow({ children: COLUMNS.map(columnHead(model, h)) }, h)] }, h),
            tableBody(
              {
                children: model.page.items.map(product =>
                  // A region per row: a change to one product sends one row.
                  region(h, { id: `product-${product.id}`, deps: [product], render: () => productRow(product, h) }),
                ),
              },
              h,
            ),
          ],
        },
        h,
      )

const pager = (model: Model, h: HtmlBuilder<Message>): Html => {
  const { total } = model.page
  const first = total === 0 ? 0 : (model.shownQuery.page - 1) * PAGE_SIZE + 1
  const last = Math.min(total, model.shownQuery.page * PAGE_SIZE)
  return h.div(
    [h.Id('pager'), h.Class('flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground')],
    [
      h.span([h.AriaLive('polite')], [`${first}–${last} of ${total} products`]),
      ...(total > PAGE_SIZE
        ? [
            paginationPages(
              {
                page: model.shownQuery.page,
                totalPages: Math.ceil(total / PAGE_SIZE),
                navigation: { kind: 'action', onNavigate: page => Message.ClickedPage({ page }) },
              },
              h,
            ),
          ]
        : []),
    ],
  )
}

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: model.query.page > 1 ? `Products, page ${model.query.page} · Catalog` : 'Products · Catalog',
  body: h.div(
    [h.Class('flex min-h-screen flex-col bg-muted/30')],
    [
      region(h, { id: HEADER_ID, deps: [model.user], render: () => header(model.user, h) }),
      h.main(
        [h.Class('mx-auto grid w-full max-w-6xl gap-4 p-4 sm:p-6')],
        [
          h.h1([h.Class('text-2xl font-semibold tracking-tight')], ['Products']),
          region(h, {
            id: 'toolbar',
            deps: [model.user, model.query.search, model.query.category, model.query.status],
            render: () => toolbar(model, h),
          }),
          h.div(
            [h.Class('rounded-xl border bg-card p-2')],
            [
              region(h, {
                id: 'results',
                deps: [model.page.items, model.shownQuery.sort, model.shownQuery.descending, model.isLoading],
                render: () => results(model, h),
              }),
            ],
          ),
          region(h, { id: 'pager', deps: [model.page.total, model.shownQuery.page], render: () => pager(model, h) }),
        ],
      ),
    ],
  ),
})

// PROGRAM

export const program: Program<Model, Message, ClientMessage, Flags, Catalog> = {
  name: 'products',
  Model,
  ClientMessage,
  flags: request =>
    Effect.gen(function* () {
      const user = yield* requireUser(request)
      const query = queryFromUrl(request.url)
      const page = yield* Catalog.use(catalog => catalog.page(query))
      return { user, query, page }
    }),
  init,
  update,
  view,
  subscriptions,
  // Address-bar updates run in the browser after the morph.
  clientCommands: {
    ReplaceUrl: ({ url }) => (typeof url === 'string' ? { replaceUrl: url } : undefined),
  },
}
