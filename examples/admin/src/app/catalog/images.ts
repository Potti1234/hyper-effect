import { Context, Data, Effect, Layer, Option } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

import { signedInUser } from '../auth'
import type { ImageRef } from './domain'

/* Product images. Uploads arrive as web `File`s (see `@hyper-effect/core`
   uploads); only PNG, JPEG, GIF and WebP are kept, recognised by their
   bytes, never by the name or the type the browser claims. SVG is refused: it
   can carry script. Images are served with their sniffed type, `nosniff` and
   a policy that allows nothing to run. In memory here, or in Postgres
   (`postgres.ts`) when several processes serve the admin; a real app would
   use object storage. */

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024

export class ImageRejected extends Data.TaggedError('ImageRejected')<{ readonly reason: string }> {}

export type Stored = Readonly<{ bytes: Uint8Array; type: string }>

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>, offset = 0) =>
  signature.every((byte, index) => bytes[offset + index] === byte)

/** The image type the bytes are, if they are one we keep. */
export const sniffImageType = (bytes: Uint8Array): string | undefined =>
  startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    ? 'image/png'
    : startsWith(bytes, [0xff, 0xd8, 0xff])
      ? 'image/jpeg'
      : startsWith(bytes, [0x47, 0x49, 0x46, 0x38])
        ? 'image/gif'
        : startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
          ? 'image/webp'
          : undefined

/** The image's bytes and sniffed type, or why it is refused. */
export const accept = (file: File): Effect.Effect<Stored, ImageRejected> =>
  Effect.gen(function* () {
    if (file.size > MAX_IMAGE_BYTES) {
      return yield* new ImageRejected({ reason: 'Images can be at most 2 MB.' })
    }
    const bytes = new Uint8Array(yield* Effect.promise(() => file.arrayBuffer()))
    const type = sniffImageType(bytes)
    if (type === undefined) {
      return yield* new ImageRejected({ reason: 'Use a PNG, JPEG, GIF or WebP image.' })
    }
    return { bytes, type }
  })

export const refOf = (id: string, file: File, stored: Stored): ImageRef => ({
  id,
  name: file.name.slice(0, 120),
  type: stored.type,
  size: stored.bytes.length,
})

export class Images extends Context.Service<
  Images,
  {
    readonly put: (file: File) => Effect.Effect<ImageRef, ImageRejected>
    readonly get: (id: string) => Effect.Effect<Option.Option<Stored>>
  }
>()('admin/Images') {
  static readonly layer = Layer.sync(Images, () => {
    const images = new Map<string, Stored>()
    return {
      put: file =>
        Effect.map(accept(file), stored => {
          const id = crypto.randomUUID()
          images.set(id, stored)
          return refOf(id, file, stored)
        }),
      get: id => Effect.sync(() => Option.fromNullishOr(images.get(id))),
    }
  })
}

export const routes = HttpRouter.add(
  'GET',
  '/images/:id',
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (signedInUser(request.cookies) === undefined) return HttpServerResponse.empty({ status: 403 })
    const { id = '' } = yield* HttpRouter.params
    const image = yield* Images.use(images => images.get(id))
    return Option.match(image, {
      onNone: () => HttpServerResponse.empty({ status: 404 }),
      onSome: ({ bytes, type }) =>
        HttpServerResponse.uint8Array(bytes, {
          contentType: type,
          headers: {
            'cache-control': 'private, max-age=3600',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox",
          },
        }),
    })
  }),
)
