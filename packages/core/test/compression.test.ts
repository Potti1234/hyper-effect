import { afterAll, assert, describe, it } from '@effect/vitest'
import zlib from 'node:zlib'

import { negotiate } from '../src/compression'
import { openPage, openStream, postEvent, serve, token } from '../src/testing'

import { program } from './fixtures/greeter'

/* Compressed event streams (experiment 4): one compressor per stream, flushed
   after every patch. */

/** Reads a compressed stream chunk by chunk, decoding as it goes, until the
 *  decoded text contains `needle`. Returns the decoded text and the
 *  compressed bytes per chunk. */
const decodeUntil = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: zlib.Gunzip,
  needle: string,
  sizes: Array<number>,
) => {
  let text = ''
  decoder.on('data', (part: Buffer) => (text += part.toString('utf8')))
  while (!text.includes(needle)) {
    const { value, done } = await reader.read()
    if (done) break
    sizes.push(value.length)
    decoder.write(value)
    // Each chunk is a complete flush: it decodes without waiting for more.
    await new Promise(resolve => setImmediate(resolve))
  }
  decoder.removeAllListeners('data')
  return text
}

describe('compressed streams', () => {
  const server = serve({ ...program, name: 'compressed' }, { compression: true })
  const plain = serve({ ...program, name: 'uncompressed' })
  afterAll(() => Promise.all([server.dispose(), plain.dispose()]))

  it('negotiates gzip, honouring q=0', () => {
    assert.strictEqual(negotiate('gzip, deflate, br'), 'gzip')
    assert.strictEqual(negotiate('br, gzip;q=0'), undefined)
    assert.strictEqual(negotiate('identity'), undefined)
    assert.strictEqual(negotiate(undefined), undefined)
  })

  it('delivers every patch at once, encoded against the earlier ones', async () => {
    const page = await openPage(server.handler)
    const response = await openStream(server.handler, page, { 'accept-encoding': 'gzip' })
    assert.strictEqual(response.headers.get('content-encoding'), 'gzip')
    assert.strictEqual(response.headers.get('x-accel-buffering'), 'no')
    const reader = response.body!.getReader()
    const decoder = zlib.createGunzip()
    const sizes: Array<number> = []
    const first = await decodeUntil(reader, decoder, '</title>', sizes)
    assert.include(first, 'hyper-effect (0)')
    const firstBytes = sizes.reduce((sum, size) => sum + size, 0)

    await postEvent(server.handler, page, { m: token({ _tag: 'ClickedIncrement' }), q: 1 })
    const before = sizes.length
    const second = await decodeUntil(reader, decoder, 'hyper-effect (1)', sizes)
    const secondBytes = sizes.slice(before).reduce((sum, size) => sum + size, 0)
    assert.include(second, 'hyper-effect (1)')
    assert.isBelow(secondBytes, firstBytes / 2, `first ${firstBytes} bytes, second ${secondBytes}`)
    await reader.cancel()
    decoder.destroy()
  })

  it('sends plain streams without the option, or to clients that do not accept gzip', async () => {
    const page = await openPage(plain.handler)
    const response = await openStream(plain.handler, page, { 'accept-encoding': 'gzip' })
    assert.isNull(response.headers.get('content-encoding'))
    await response.body?.cancel()
    const other = await openPage(server.handler)
    const identity = await openStream(server.handler, other, { 'accept-encoding': 'br' })
    assert.isNull(identity.headers.get('content-encoding'))
    await identity.body?.cancel()
  })
})
