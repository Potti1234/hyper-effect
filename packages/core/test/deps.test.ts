import { assert, describe, it } from '@effect/vitest'
import { Data, Option } from 'effect'

import { equalValues, sameDeps } from '../src/deps'

describe('deps', () => {
  it('compare Model data by value', () => {
    const incident = { id: 'INC-1', location: { longitude: 1, latitude: 2 }, comments: [{ text: 'a' }] }
    assert.isTrue(equalValues(incident, structuredClone(incident)))
    assert.isFalse(equalValues(incident, { ...incident, comments: [{ text: 'b' }] }))
    assert.isFalse(equalValues({ a: 1 }, { a: 1, b: undefined }))
    assert.isFalse(equalValues([1, 2], [1, 2, 3]))
    assert.isFalse(equalValues([1], { 0: 1, length: 1 }))
    assert.isTrue(equalValues(Number.NaN, Number.NaN))
    assert.isTrue(equalValues(new Date(5), new Date(5)))
    assert.isFalse(equalValues(new Date(5), new Date(6)))
    assert.isFalse(equalValues(null, {}))
  })

  it('use Effect equality where values have it', () => {
    assert.isTrue(equalValues(Option.some({ id: 1 }), Option.some({ id: 1 })))
    assert.isFalse(equalValues(Option.some(1), Option.none()))
    class Point extends Data.Class<{ x: number }> {}
    assert.isTrue(equalValues(new Point({ x: 1 }), new Point({ x: 1 })))
  })

  it('compare deps position by position', () => {
    assert.isTrue(sameDeps(['a', [1, 2], { b: true }], ['a', [1, 2], { b: true }]))
    assert.isFalse(sameDeps(['a'], ['a', undefined]))
  })
})
