import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { KeyValueStore } from 'effect/persistence'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fileStore } from '../src/file-store'

/* Snapshots in files are replaced whole: a reader finds the old snapshot or
   the new one, never part of one, and no temporary file stays behind. */

const inDirectory = <A, E>(use: (directory: string) => Effect.Effect<A, E, KeyValueStore.KeyValueStore>) => {
  const directory = mkdtempSync(join(tmpdir(), 'hyper-store-'))
  return use(directory).pipe(
    Effect.provide(fileStore(directory).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => rmSync(directory, { recursive: true, force: true }))),
  )
}

describe('fileStore', () => {
  it.live('stores, replaces and removes values, under the file names of layerFileSystem', () =>
    inDirectory(directory =>
      Effect.gen(function* () {
        const store = yield* KeyValueStore.KeyValueStore
        yield* store.set('hyper/board/w1.id', 'first')
        yield* store.set('hyper/board/w1.id', 'second')
        assert.strictEqual(yield* store.get('hyper/board/w1.id'), 'second')
        assert.deepStrictEqual(readdirSync(directory), [encodeURIComponent('hyper/board/w1.id')])
        yield* store.remove('hyper/board/w1.id')
        assert.isUndefined(yield* store.get('hyper/board/w1.id'))
      }),
    ),
  )

  it.live('concurrent writers leave one whole value', () =>
    inDirectory(directory =>
      Effect.gen(function* () {
        const store = yield* KeyValueStore.KeyValueStore
        const values = Array.from({ length: 40 }, (_, index) => `${index}:${'x'.repeat(20_000)}`)
        yield* Effect.forEach(values, value => store.set('key', value), { concurrency: 'unbounded' })
        assert.include(values, yield* store.get('key'))
        assert.deepStrictEqual(readdirSync(directory), ['key'])
      }),
    ),
  )

  it.live('a write that never finished leaves the previous value readable', () =>
    inDirectory(directory =>
      Effect.gen(function* () {
        const store = yield* KeyValueStore.KeyValueStore
        yield* store.set('key', 'whole')
        // What a process killed mid-write leaves: a partial temporary file.
        writeFileSync(join(directory, 'key.999-1.tmp'), 'who')
        assert.strictEqual(yield* store.get('key'), 'whole')
      }),
    ),
  )
})
