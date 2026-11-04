import { assert, describe, it } from '@effect/vitest'
import { Scene, Story } from 'foldkit/test'

import { type Product, draftOf } from '@/app/catalog/domain'
import * as Edit from '@/app/products/edit'

/* The edit page's update and view with Foldkit's Story and Scene. */

const product: Product = {
  id: 'P0007',
  sku: 'TLS-1007',
  name: 'Steel hammer',
  category: 'Tools',
  price: 1250,
  stock: 3,
  status: 'active',
  description: '',
  image: null,
  updatedAt: 0,
  updatedBy: 'seed',
  revision: 4,
}

const editor = { name: 'ada', role: 'editor' } as const
const viewer = { name: 'grace', role: 'viewer' } as const

const model = (overrides: Partial<Edit.Model> = {}): Edit.Model => ({
  ...Edit.init({ user: editor, product }).model,
  ...overrides,
})

const png = (size = 8) => new File([new Uint8Array(size)], 'photo.png', { type: 'image/png' })
const image = { id: 'img-1', name: 'photo.png', type: 'image/png', size: 8 }

describe('product editor: update (Story)', () => {
  it('lets viewers change nothing, whatever the page sends', () => {
    Story.story(
      Edit.update,
      Story.given(model({ user: viewer })),
      Story.message(Edit.Message.ChangedField({ field: 'name', value: 'Hacked' })),
      Story.message(Edit.Message.ClickedSave()),
      Story.message(Edit.Message.ChoseImage({ files: [png()] })),
      Story.message(Edit.Message.ClickedConfirmDelete()),
      Story.Command.expectNone(),
      Story.model(next => assert.strictEqual(next.draft.name, 'Steel hammer')),
    )
  })

  it('shows Schema errors next to the fields instead of saving', () => {
    Story.story(
      Edit.update,
      Story.given(model({ draft: { ...draftOf(product), name: ' ', price: '12,50', sku: 'tls-7' } })),
      Story.message(Edit.Message.ClickedSave()),
      Story.Command.expectNone(),
      Story.model(next => {
        assert.deepStrictEqual(Object.keys(next.errors).sort(), ['name', 'price', 'sku'])
        assert.strictEqual(next.errors['price'], 'A price like 12.50.')
      }),
    )
  })

  it('saves from the revision it started at, and turns a conflict into a choice', () => {
    const theirs = { ...product, name: 'Their hammer', revision: 5, updatedBy: 'other' }
    Story.story(
      Edit.update,
      Story.given(model({ draft: { ...draftOf(product), name: 'My hammer' } })),
      Story.message(Edit.Message.ClickedSave()),
      Story.model(next => assert.strictEqual(next.saveState._tag, 'Saving')),
      Story.Command.resolve(Edit.SaveProduct, Edit.Message.FoundConflict({ current: theirs })),
      Story.model(next => {
        assert.strictEqual(next.conflict?.revision, 5)
        assert.strictEqual(next.draft.name, 'My hammer')
      }),
      Story.message(Edit.Message.ClickedTakeTheirs()),
      Story.model(next => {
        assert.isNull(next.conflict)
        assert.strictEqual(next.draft.name, 'Their hammer')
        assert.strictEqual(next.product?.revision, 5)
      }),
    )
  })

  it('uploads a chosen image and keeps only the reference', () => {
    Story.story(
      Edit.update,
      Story.given(model()),
      Story.message(Edit.Message.ChoseImage({ files: [png()] })),
      Story.model(next => assert.strictEqual(next.imageState._tag, 'Uploading')),
      Story.Command.resolve(Edit.StoreImage, Edit.Message.StoredImage({ image })),
      Story.model(next => {
        assert.deepStrictEqual(next.image, image)
        assert.strictEqual(next.imageState._tag, 'Idle')
      }),
    )
  })

  it('refuses images over 2 MB before uploading them anywhere', () => {
    Story.story(
      Edit.update,
      Story.given(model()),
      Story.message(Edit.Message.ChoseImage({ files: [png(3 * 1024 * 1024)] })),
      Story.Command.expectNone(),
      Story.model(next => assert.strictEqual(next.imageState._tag, 'Failed')),
    )
  })

  it('notices when someone else saved meanwhile', () => {
    Story.story(
      Edit.update,
      Story.given(model()),
      Story.message(Edit.Message.ChangedCatalog()),
      Story.Command.resolve(Edit.LoadCurrent, Edit.Message.GotCurrent({ current: { ...product, revision: 5 } })),
      Story.model(next => assert.strictEqual(next.conflict?.revision, 5)),
    )
  })
})

describe('product editor: view (Scene)', () => {
  it('uploads from the file input and shows the image', () => {
    Scene.scene(
      Edit.program,
      Scene.given(model()),
      Scene.changeFiles(Scene.selector('#image-file'), [png()]),
      Scene.Command.resolve(Edit.StoreImage, Edit.Message.StoredImage({ image })),
      Scene.expect(Scene.altText('photo.png')).toHaveAttr('src', '/images/img-1'),
    )
  })

  it('is read-only for viewers', () => {
    Scene.scene(
      Edit.program,
      Scene.given(model({ user: viewer })),
      // Read-only inputs are a DOM property in Foldkit's vnodes; the browser
      // check asserts the attribute on the server-rendered page.
      Scene.expect(Scene.role('button', { name: 'Save changes' })).toBeAbsent(),
      Scene.expect(Scene.selector('#image-file')).toBeAbsent(),
    )
  })
})
