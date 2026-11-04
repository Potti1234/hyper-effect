import { Effect, Stream } from 'effect'
import zlib from 'node:zlib'

/* Compression of event streams (experiment 4).

   One compressor per stream, flushed after every chunk: the browser gets each
   patch at once, and every patch is encoded against the earlier ones of the
   same stream. Region patches repeat most of their markup from one change to
   the next, which a per-message compressor (or none) cannot use.

   gzip, with a 16 kB window and memory level 6: on Dispatch's patches it
   sends 164 bytes for a 5.9 kB region patch and keeps about 165 kB per
   stream. Brotli compresses those patches to 57–98 bytes, but keeps 360–600
   kB per stream; with many open pages memory matters more than the last
   hundred bytes (docs/performance.md). */

export type Encoding = 'gzip'

/** The encoding to use for a request, from its `Accept-Encoding`. */
export const negotiate = (acceptEncoding: string | undefined): Encoding | undefined => {
  const accepted = (acceptEncoding ?? '')
    .split(',')
    .map(part => part.trim().split(';'))
    .filter(([, quality]) => quality === undefined || !/^q=0(\.0*)?$/.test(quality.trim()))
    .map(([name]) => name?.trim().toLowerCase())
  return accepted.includes('gzip') ? 'gzip' : undefined
}

const makeCompressor = () => zlib.createGzip({ level: 6, windowBits: 14, memLevel: 6 })

/** Compresses `body` for one response; `onChunk` sees each compressed size. */
export const compress =
  (onChunk: (bytes: number) => void = () => {}) =>
  <E, R>(body: Stream.Stream<Uint8Array, E, R>): Stream.Stream<Uint8Array, E, R> =>
    Stream.suspend(() => {
      const compressor = makeCompressor()
      const flushKind = zlib.constants.Z_SYNC_FLUSH
      const parts: Array<Buffer> = []
      compressor.on('data', (part: Buffer) => parts.push(part))
      const compressChunk = (chunk: Uint8Array) =>
        Effect.callback<Uint8Array>(resume => {
          compressor.write(chunk)
          compressor.flush(flushKind, () => {
            const out = Buffer.concat(parts.splice(0))
            onChunk(out.length)
            resume(Effect.succeed(out))
          })
        })
      return body.pipe(
        Stream.mapEffect(compressChunk),
        Stream.filter(chunk => chunk.length > 0),
        Stream.ensuring(Effect.sync(() => compressor.close())),
      )
    })
