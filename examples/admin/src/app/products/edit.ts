import { Effect, Match as M, Schema as S, Stream } from 'effect'
import { Command, Subscription, type Update } from 'foldkit'
import * as FoldkitFile from 'foldkit/file'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import * as Navigation from 'foldkit/navigation'

import { PageNotFound, type Program, region } from '@hyper-effect/core'

import { cn } from '@/lib/utils'
import { alert, alertDescription, alertTitle } from '@/ui/alert'
import { button } from '@/ui/button'
import { card } from '@/ui/card'
import { input } from '@/ui/input'
import { nativeSelect } from '@/ui/native-select'
import { textarea } from '@/ui/textarea'

import { User, canEdit, requireUser } from '../auth'
import {
  Categories,
  Draft,
  ImageRef,
  Product,
  Statuses,
  draftOf,
  emptyDraft,
  statusLabel,
  validateDraft,
} from '../catalog/domain'
import { Images, MAX_IMAGE_BYTES } from '../catalog/images'
import { Catalog } from '../catalog/store'
import { HEADER_ID, formatDate, header, linkButton } from '../layout'

/* One product: create (`/products/new`) or edit (`/products/:id`).
   - The form is validated with a Schema on save; errors sit next to fields.
   - The image is uploaded as soon as it is chosen or dropped: the file reaches
     `update` as a web `File`, a Command stores it, the Model keeps a reference.
   - Saving checks the revision the editor started from. When someone else
     saved in between, nothing is overwritten: the editor sees a conflict and
     decides. Changes by others also show up live while editing.
   - Viewers see the form read-only; `update` checks the role again. */

// MODEL

const Idle = S.TaggedStruct('Idle', {})
const Uploading = S.TaggedStruct('Uploading', {})
const Saving = S.TaggedStruct('Saving', {})
const Saved = S.TaggedStruct('Saved', { at: S.Number })
const Failed = S.TaggedStruct('Failed', { reason: S.String })

export const Model = S.Struct({
  user: User,
  /** Null while creating. */
  product: S.NullOr(Product),
  draft: Draft,
  errors: S.Record(S.String, S.String),
  image: S.NullOr(ImageRef),
  imageState: S.Union([Idle, Uploading, Failed]),
  saveState: S.Union([Idle, Saving, Saved, Failed]),
  /** A newer version someone else saved while this one was being edited. */
  conflict: S.NullOr(Product),
  isConfirmingDelete: S.Boolean,
})
export type Model = typeof Model.Type

// MESSAGE

export const Field = S.Literals(['sku', 'name', 'category', 'price', 'stock', 'status', 'description'])
export type Field = typeof Field.Type

export const Message = defineMessageUnion({
  ChangedField: { field: Field, value: S.String },
  ChoseImage: { files: S.Array(FoldkitFile.File) },
  StoredImage: { image: ImageRef },
  RejectedImage: { reason: S.String },
  ClickedRemoveImage: {},
  ClickedSave: {},
  SavedProduct: { product: Product, isNew: S.Boolean },
  FailedSave: { field: S.String, reason: S.String },
  FoundConflict: { current: Product },
  ClickedTakeTheirs: {},
  ClickedDelete: {},
  ClickedCancelDelete: {},
  ClickedConfirmDelete: {},
  DeletedProduct: {},
  ChangedCatalog: {},
  GotCurrent: { current: S.NullOr(Product) },
  CompletedNavigation: {},
})
export type Message = typeof Message.Type

export const ClientMessage = S.Union([
  Message.ClickedRemoveImage,
  Message.ClickedSave,
  Message.ClickedTakeTheirs,
  Message.ClickedDelete,
  Message.ClickedCancelDelete,
  Message.ClickedConfirmDelete,
])
export type ClientMessage = typeof ClientMessage.Type

// COMMAND

export const StoreImage = Command.define('StoreImage', {
  args: { file: FoldkitFile.File },
  messages: [Message.StoredImage, Message.RejectedImage],
  execute: ({ file }) =>
    Images.use(images => images.put(file)).pipe(
      Effect.map(image => Message.StoredImage({ image })),
      Effect.catchTag('ImageRejected', ({ reason }) => Effect.succeed(Message.RejectedImage({ reason }))),
    ),
})

export const SaveProduct = Command.define('SaveProduct', {
  args: {
    id: S.NullOr(S.String),
    revision: S.Number,
    draft: Draft,
    image: S.NullOr(ImageRef),
    by: S.String,
  },
  messages: [Message.SavedProduct, Message.FailedSave, Message.FoundConflict],
  execute: ({ id, revision, draft, image, by }) =>
    Effect.gen(function* () {
      const validated = validateDraft(draft)
      if (validated._tag === 'Invalid') {
        return Message.FailedSave({ field: '', reason: 'Check the form.' })
      }
      const catalog = yield* Catalog
      const changes = { input: validated.input, image }
      return yield* (id === null
        ? catalog.create(changes, by).pipe(Effect.map(product => Message.SavedProduct({ product, isNew: true })))
        : catalog.update(id, revision, changes, by).pipe(Effect.map(product => Message.SavedProduct({ product, isNew: false })))
      ).pipe(
        Effect.catchTags({
          SkuTaken: ({ sku }) => Effect.succeed(Message.FailedSave({ field: 'sku', reason: `${sku} is already used by another product.` })),
          StaleRevision: ({ current }) => Effect.succeed(Message.FoundConflict({ current })),
          ProductNotFound: () => Effect.succeed(Message.FailedSave({ field: '', reason: 'This product was deleted.' })),
        }),
      )
    }),
})

export const DeleteProduct = Command.define('DeleteProduct', {
  args: { id: S.String },
  messages: [Message.DeletedProduct],
  execute: ({ id }) =>
    Catalog.use(catalog => catalog.remove(id)).pipe(
      Effect.ignore,
      Effect.as(Message.DeletedProduct()),
    ),
})

export const LoadCurrent = Command.define('LoadCurrent', {
  args: { id: S.String },
  messages: [Message.GotCurrent],
  execute: ({ id }) =>
    Catalog.use(catalog => catalog.find(id)).pipe(
      Effect.map(current => Message.GotCurrent({ current })),
      Effect.orElseSucceed(() => Message.GotCurrent({ current: null })),
    ),
})

/** In a browser this runs Foldkit's `Navigation.load`; on the server it is
 *  forwarded to the page. */
export const LoadUrl = Command.define('LoadUrl', {
  args: { url: S.String },
  messages: [Message.CompletedNavigation],
  execute: ({ url }) => Navigation.load(url).pipe(Effect.as(Message.CompletedNavigation())),
})

// INIT

export type Flags = Readonly<{ user: User; product: Product | null }>

export const init = ({ user, product }: Flags): Update.Return<Model, Message> => ({
  model: {
    user,
    product,
    draft: product === null ? emptyDraft : draftOf(product),
    errors: {},
    image: product?.image ?? null,
    imageState: Idle.make({}),
    saveState: Idle.make({}),
    conflict: null,
    isConfirmingDelete: false,
  },
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Catalog | Images>

/** Viewers may look, not change: every write is checked here, whatever the
 *  page shows. */
const editing = (model: Model, change: () => UpdateReturn): UpdateReturn =>
  canEdit(model.user) ? change() : { model }

const chooseImage = (model: Model, files: ReadonlyArray<File>): UpdateReturn => {
  const file = files[0]
  if (file === undefined) return { model }
  if (files.length > 1) return { model: { ...model, imageState: Failed.make({ reason: 'Choose one image.' }) } }
  if (file.size > MAX_IMAGE_BYTES) {
    return { model: { ...model, imageState: Failed.make({ reason: 'Images can be at most 2 MB.' }) } }
  }
  return { model: { ...model, imageState: Uploading.make({}) }, commands: [StoreImage({ file })] }
}

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ChangedField: ({ field, value }) =>
        editing(model, () => {
          const { [field]: _, ...errors } = model.errors
          return {
            model: {
              ...model,
              draft: { ...model.draft, [field]: value },
              errors,
              saveState: model.saveState._tag === 'Saved' ? Idle.make({}) : model.saveState,
            },
          }
        }),
      ChoseImage: ({ files }) => editing(model, () => chooseImage(model, files)),
      StoredImage: ({ image }) => ({ model: { ...model, image, imageState: Idle.make({}) } }),
      RejectedImage: ({ reason }) => ({ model: { ...model, imageState: Failed.make({ reason }) } }),
      ClickedRemoveImage: () => editing(model, () => ({ model: { ...model, image: null } })),
      ClickedSave: () =>
        editing(model, () => {
          if (model.saveState._tag === 'Saving') return { model }
          const validated = validateDraft(model.draft)
          if (validated._tag === 'Invalid') {
            return { model: { ...model, errors: validated.errors, saveState: Idle.make({}) } }
          }
          return {
            model: { ...model, errors: {}, saveState: Saving.make({}) },
            commands: [
              SaveProduct({
                id: model.product?.id ?? null,
                revision: model.product?.revision ?? 0,
                draft: model.draft,
                image: model.image,
                by: model.user.name,
              }),
            ],
          }
        }),
      SavedProduct: ({ product, isNew }) =>
        isNew
          ? { model: { ...model, product, saveState: Saved.make({ at: product.updatedAt }) }, commands: [LoadUrl({ url: `/products/${product.id}` })] }
          : {
              model: {
                ...model,
                product,
                draft: draftOf(product),
                image: product.image,
                conflict: null,
                saveState: Saved.make({ at: product.updatedAt }),
              },
            },
      FailedSave: ({ field, reason }) => ({
        model: {
          ...model,
          errors: field === '' ? model.errors : { ...model.errors, [field]: reason },
          saveState: Failed.make({ reason }),
        },
      }),
      FoundConflict: ({ current }) => ({ model: { ...model, conflict: current, saveState: Idle.make({}) } }),
      // Drop the local edits and continue from the saved version.
      ClickedTakeTheirs: () =>
        model.conflict === null
          ? { model }
          : {
              model: {
                ...model,
                product: model.conflict,
                draft: draftOf(model.conflict),
                image: model.conflict.image,
                conflict: null,
                errors: {},
              },
            },
      ClickedDelete: () => editing(model, () => ({ model: { ...model, isConfirmingDelete: true } })),
      ClickedCancelDelete: () => ({ model: { ...model, isConfirmingDelete: false } }),
      ClickedConfirmDelete: () =>
        editing(model, () =>
          model.product === null ? { model } : { model, commands: [DeleteProduct({ id: model.product.id })] },
        ),
      DeletedProduct: () => ({ model, commands: [LoadUrl({ url: '/products' })] }),
      ChangedCatalog: () =>
        model.product === null || model.saveState._tag === 'Saving'
          ? { model }
          : { model, commands: [LoadCurrent({ id: model.product.id })] },
      // Someone else saved (or deleted) this product meanwhile.
      GotCurrent: ({ current }) => {
        if (model.product === null || model.saveState._tag === 'Saving') return { model }
        if (current === null) {
          return { model: { ...model, saveState: Failed.make({ reason: 'Someone deleted this product.' }) } }
        }
        return current.revision === model.product.revision ? { model } : { model: { ...model, conflict: current } }
      },
      CompletedNavigation: () => ({ model }),
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
            Effect.succeed(catalog.changes.pipe(Stream.drop(1), Stream.map(() => Message.ChangedCatalog()))),
          ),
        ),
    },
  ),
}))

// VIEW

const textField = (
  model: Model,
  field: Field,
  config: Readonly<{ label: string; placeholder?: string; inputMode?: 'decimal' | 'numeric' }>,
  h: HtmlBuilder<Message>,
): Html => {
  const error = model.errors[field]
  return input(
    {
      id: field,
      label: config.label,
      value: model.draft[field],
      ...(config.placeholder === undefined ? {} : { placeholder: config.placeholder }),
      ...(config.inputMode === undefined ? {} : { inputMode: config.inputMode }),
      ...(error === undefined ? {} : { description: error, isInvalid: true }),
      isReadOnly: !canEdit(model.user),
      onInput: value => Message.ChangedField({ field, value }),
    },
    h,
  )
}

const selectField = (
  model: Model,
  field: 'category' | 'status',
  label: string,
  options: ReadonlyArray<Readonly<{ value: string; label: string }>>,
  h: HtmlBuilder<Message>,
): Html => {
  const error = model.errors[field]
  return nativeSelect(
    {
      id: field,
      label,
      value: model.draft[field],
      options,
      ...(error === undefined ? {} : { description: error, isInvalid: true }),
      isDisabled: !canEdit(model.user),
      onChange: value => Message.ChangedField({ field, value }),
    },
    h,
  )
}

const imagePanel = (model: Model, h: HtmlBuilder<Message>): Html => {
  const editable = canEdit(model.user)
  return h.div(
    [h.Id('image-panel'), h.Class('grid gap-3')],
    [
      h.span([h.Class('text-sm font-medium')], ['Image']),
      model.image === null
        ? h.div(
            [h.Class('flex aspect-square items-center justify-center rounded-lg border bg-muted/40 text-sm text-muted-foreground')],
            ['No image'],
          )
        : h.img([
            h.Src(`/images/${model.image.id}`),
            h.Alt(model.image.name),
            h.Class('aspect-square w-full rounded-lg border object-cover'),
          ]),
      ...(editable
        ? [
            h.label(
              [
                h.Id('image-drop'),
                h.For('image-file'),
                h.Class(
                  cn(
                    'flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground hover:bg-muted/50',
                    model.imageState._tag === 'Uploading' && 'opacity-60',
                  ),
                ),
                h.AllowDrop(),
                h.OnDropFiles(files => Message.ChoseImage({ files })),
              ],
              [
                model.imageState._tag === 'Uploading' ? 'Uploading…' : 'Drop an image here, or click to choose one',
                h.span([h.Class('text-xs')], ['PNG, JPEG, GIF or WebP, up to 2 MB']),
              ],
            ),
            h.input([
              h.Id('image-file'),
              h.Type('file'),
              h.Accept('image/png,image/jpeg,image/gif,image/webp'),
              h.Class('sr-only'),
              h.OnFileChange(files => Message.ChoseImage({ files })),
            ]),
            ...(model.image === null
              ? []
              : [button({ children: ['Remove image'], variant: 'outline', size: 'sm', onClick: Message.ClickedRemoveImage() }, h)]),
          ]
        : []),
      ...(model.imageState._tag === 'Failed'
        ? [h.p([h.Role('alert'), h.Class('text-sm text-destructive')], [model.imageState.reason])]
        : []),
    ],
  )
}

const conflictNotice = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Id('conflict')],
    model.conflict === null
      ? []
      : [
          alert(
            {
              announcement: 'alert',
              severity: 'warning',
              children: [
                alertTitle({ children: [`${model.conflict.updatedBy} saved this product at ${formatDate(model.conflict.updatedAt)}`] }, h),
                alertDescription(
                  {
                    children: [
                      'Saving now would overwrite their changes, so it is refused. Take their version to continue from it.',
                      h.div(
                        [h.Class('mt-2')],
                        [button({ children: ['Take their version'], size: 'sm', onClick: Message.ClickedTakeTheirs() }, h)],
                      ),
                    ],
                  },
                  h,
                ),
              ],
            },
            h,
          ),
        ],
  )

const actions = (model: Model, h: HtmlBuilder<Message>): Html => {
  const editable = canEdit(model.user)
  const status =
    model.saveState._tag === 'Saved'
      ? `Saved ${formatDate(model.saveState.at)}`
      : model.saveState._tag === 'Failed'
        ? model.saveState.reason
        : ''
  return h.div(
    [h.Id('actions'), h.Class('flex flex-wrap items-center justify-between gap-3')],
    [
      h.div(
        [h.Class('flex items-center gap-2')],
        editable
          ? [
              button(
                {
                  children: [model.product === null ? 'Create product' : 'Save changes'],
                  type: 'submit',
                  isLoading: model.saveState._tag === 'Saving',
                  loadingContent: ['Saving…'],
                },
                h,
              ),
              linkButton({ href: '/products', label: 'Back to list', variant: 'ghost' }, h),
            ]
          : [linkButton({ href: '/products', label: 'Back to list', variant: 'outline' }, h)],
      ),
      h.span(
        [h.AriaLive('polite'), h.Class(cn('text-sm', model.saveState._tag === 'Failed' ? 'text-destructive' : 'text-muted-foreground'))],
        [status],
      ),
      ...(editable && model.product !== null
        ? [
            model.isConfirmingDelete
              ? h.div(
                  [h.Class('flex items-center gap-2 text-sm')],
                  [
                    'Delete this product?',
                    button({ children: ['Delete'], variant: 'destructive', size: 'sm', onClick: Message.ClickedConfirmDelete() }, h),
                    button({ children: ['Keep'], variant: 'ghost', size: 'sm', onClick: Message.ClickedCancelDelete() }, h),
                  ],
                )
              : button({ children: ['Delete…'], variant: 'ghost', size: 'sm', onClick: Message.ClickedDelete() }, h),
          ]
        : []),
    ],
  )
}

const form = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.form(
    [h.Id('product-form'), h.Class('grid gap-4'), h.OnSubmit(Message.ClickedSave())],
    [
      h.div(
        [h.Class('grid gap-4 sm:grid-cols-2')],
        [
          textField(model, 'name', { label: 'Name', placeholder: 'Steel hammer' }, h),
          textField(model, 'sku', { label: 'SKU', placeholder: 'TLS-0042' }, h),
          selectField(model, 'category', 'Category', [
            { value: '', label: 'Choose…' },
            ...Categories.map(value => ({ value, label: value })),
          ], h),
          selectField(model, 'status', 'Status', Statuses.map(value => ({ value, label: statusLabel[value] })), h),
          textField(model, 'price', { label: 'Price (EUR)', placeholder: '12.50', inputMode: 'decimal' }, h),
          textField(model, 'stock', { label: 'Stock', inputMode: 'numeric' }, h),
        ],
      ),
      textarea(
        {
          id: 'description',
          label: 'Description',
          value: model.draft.description,
          rows: 4,
          isReadOnly: !canEdit(model.user),
          ...(model.errors['description'] === undefined ? {} : { description: model.errors['description'], isInvalid: true }),
          onInput: value => Message.ChangedField({ field: 'description', value }),
        },
        h,
      ),
      region(h, {
        id: 'actions',
        deps: [model.user, model.product, model.saveState, model.isConfirmingDelete],
        render: () => actions(model, h),
      }),
    ],
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `${model.product === null ? 'New product' : model.product.name} · Catalog`,
  body: h.div(
    [h.Class('flex min-h-screen flex-col bg-muted/30')],
    [
      region(h, { id: HEADER_ID, deps: [model.user], render: () => header(model.user, h) }),
      h.main(
        [h.Class('mx-auto grid w-full max-w-5xl gap-4 p-4 sm:p-6')],
        [
          h.div(
            [h.Class('flex flex-wrap items-baseline justify-between gap-2')],
            [
              h.h1([h.Class('text-2xl font-semibold tracking-tight')], [model.product === null ? 'New product' : model.product.name]),
              ...(model.product === null
                ? []
                : [
                    h.span(
                      [h.Class('text-sm text-muted-foreground')],
                      [`${model.product.id} · revision ${model.product.revision} · ${formatDate(model.product.updatedAt)} by ${model.product.updatedBy}`],
                    ),
                  ]),
            ],
          ),
          region(h, { id: 'conflict', deps: [model.conflict], render: () => conflictNotice(model, h) }),
          h.div(
            [h.Class('grid gap-4 md:grid-cols-[1fr_260px]')],
            [
              card(
                {
                  id: 'product-card',
                  class: 'px-(--card-spacing)',
                  children: [
                    region(h, {
                      id: 'product-form',
                      // Covers the nested actions region's deps: a kept region
                      // keeps its nested regions as they are.
                      deps: [model.user, model.product, model.draft, model.errors, model.saveState, model.isConfirmingDelete],
                      render: () => form(model, h),
                    }),
                  ],
                },
                h,
              ),
              card(
                {
                  class: 'px-(--card-spacing)',
                  children: [
                    region(h, {
                      id: 'image-panel',
                      deps: [model.user, model.image, model.imageState],
                      render: () => imagePanel(model, h),
                    }),
                  ],
                },
                h,
              ),
            ],
          ),
        ],
      ),
    ],
  ),
})

// PROGRAM

export const program: Program<Model, Message, ClientMessage, Flags, Catalog | Images> = {
  name: 'product',
  Model,
  ClientMessage,
  flags: request =>
    Effect.gen(function* () {
      const user = yield* requireUser(request)
      const id = request.params['id'] ?? ''
      if (id === 'new') {
        // Viewers cannot create; the list does not offer it either.
        if (!canEdit(user)) return yield* new PageNotFound()
        return { user, product: null }
      }
      const product = yield* Catalog.use(catalog => catalog.find(id)).pipe(
        Effect.mapError(() => new PageNotFound()),
      )
      return { user, product }
    }),
  init,
  update,
  view,
  subscriptions,
  clientCommands: {
    LoadUrl: ({ url }) => (typeof url === 'string' ? { load: url } : undefined),
  },
}
