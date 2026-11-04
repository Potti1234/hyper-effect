import { assert, describe, it } from '@effect/vitest'
import { Scene, Story } from 'foldkit/test'
import type { ApplicationConfigWithFlags } from 'foldkit/runtime'

import type { Product } from '@/app/catalog/domain'
import { defaultQuery } from '@/app/catalog/domain'
import type { Catalog } from '@/app/catalog/store'
import * as List from '@/app/products/list'

/* The list page's update and view, tested with Foldkit's own Story and Scene
   helpers: a server program's update and view are plain Foldkit functions. */

const product = (index: number, overrides: Partial<Product> = {}): Product => ({
  id: `P${index}`,
  sku: `TLS-${1000 + index}`,
  name: `Hammer ${index}`,
  category: 'Tools',
  price: 1000 + index,
  stock: index,
  status: 'active',
  description: '',
  image: null,
  updatedAt: 0,
  updatedBy: 'seed',
  revision: 1,
  ...overrides,
})

const editor = { name: 'ada', role: 'editor' } as const
const viewer = { name: 'grace', role: 'viewer' } as const

const model: List.Model = {
  user: editor,
  query: defaultQuery,
  page: { items: [product(1), product(2)], total: 45 },
  shownQuery: defaultQuery,
  isLoading: false,
}

// Compile-time: the program's Foldkit part fits Foldkit's application config,
// so the same Model, init, update, view and subscriptions could run in a
// browser runtime.
type FoldkitCore = Pick<
  ApplicationConfigWithFlags<List.Model, List.Message, List.Flags, Catalog>,
  'Model' | 'update' | 'view' | 'subscriptions' | 'init'
>
const portable: FoldkitCore = List.program
void portable

describe('product list: update (Story)', () => {
  it('searching starts at page 1, loads, and mirrors the query into the URL', () => {
    const searched = { ...defaultQuery, search: 'hammer' }
    Story.story(
      List.update,
      Story.given({ ...model, query: { ...defaultQuery, page: 3 } }),
      Story.message(List.Message.ChangedSearch({ search: 'hammer' })),
      Story.model(next => {
        assert.deepStrictEqual(next.query, searched)
        assert.isTrue(next.isLoading)
      }),
      Story.Command.resolve(List.ReplaceUrl, List.Message.CompletedReplaceUrl()),
      Story.Command.resolve(
        List.LoadPage,
        List.Message.GotPage({ query: searched, page: { items: [product(9)], total: 1 } }),
      ),
      Story.model(next => {
        assert.isFalse(next.isLoading)
        assert.deepStrictEqual(next.page.items.map(item => item.id), ['P9'])
      }),
    )
  })

  it('ignores a page that answers an older query', () => {
    Story.story(
      List.update,
      Story.given({ ...model, query: { ...defaultQuery, search: 'new' }, isLoading: true }),
      Story.message(List.Message.GotPage({ query: { ...defaultQuery, search: 'old' }, page: { items: [], total: 0 } })),
      Story.model(next => {
        assert.strictEqual(next.page.total, 45)
        assert.isTrue(next.isLoading)
      }),
    )
  })

  it('sorting the same column flips the direction', () => {
    Story.story(
      List.update,
      Story.given({ ...model, query: { ...defaultQuery, sort: 'price', descending: false } }),
      Story.message(List.Message.ClickedSort({ column: 'price' })),
      Story.model(next => assert.isTrue(next.query.descending)),
      Story.Command.resolve(List.ReplaceUrl, List.Message.CompletedReplaceUrl()),
      Story.Command.resolve(
        List.LoadPage,
        List.Message.GotPage({ query: { ...defaultQuery, sort: 'price', descending: true }, page: model.page }),
      ),
    )
  })
})

describe('product list: view (Scene)', () => {
  it('renders rows, pages and the create link for editors', () => {
    Scene.scene(
      List.program,
      Scene.given(model),
      Scene.expect(Scene.selector('#product-P1')).toContainText('Hammer 1'),
      Scene.expect(Scene.selector('#pager span')).toHaveText('1–20 of 45 products'),
      Scene.expect(Scene.role('link', { name: 'New product' })).toExist(),
    )
  })

  it('hides the create link from viewers', () => {
    Scene.scene(
      List.program,
      Scene.given({ ...model, user: viewer }),
      Scene.expect(Scene.role('link', { name: 'New product' })).toBeAbsent(),
    )
  })

  it('pages with the pagination buttons', () => {
    Scene.scene(
      List.program,
      Scene.given(model),
      Scene.click(Scene.role('button', { name: 'Go to page 2' })),
      Scene.Command.expectHas(List.LoadPage, List.ReplaceUrl),
      Scene.Command.resolve(List.ReplaceUrl, List.Message.CompletedReplaceUrl()),
      Scene.Command.resolve(
        List.LoadPage,
        List.Message.GotPage({ query: { ...defaultQuery, page: 2 }, page: { items: [product(21)], total: 45 } }),
      ),
      Scene.expect(Scene.selector('#product-P21')).toExist(),
      Scene.expect(Scene.selector('#pager span')).toHaveText('21–40 of 45 products'),
    )
  })
})
