import { afterEach, assert, describe, it } from '@effect/vitest'

import { secretFromEnvironment } from '../src/security'

/* secretFromEnvironment: development falls back, production refuses to. */

const original = { ...process.env }

describe('secretFromEnvironment', () => {
  afterEach(() => {
    process.env['NODE_ENV'] = original['NODE_ENV']
    delete process.env['TEST_SECRET']
  })

  it('falls back to the development value outside production', () => {
    process.env['NODE_ENV'] = 'test'
    assert.strictEqual(secretFromEnvironment('TEST_SECRET', 'dev'), 'dev')
    process.env['TEST_SECRET'] = 'short'
    assert.strictEqual(secretFromEnvironment('TEST_SECRET', 'dev'), 'short')
  })

  it('refuses a missing or short secret in production', () => {
    process.env['NODE_ENV'] = 'production'
    assert.throws(() => secretFromEnvironment('TEST_SECRET', 'dev'), /set TEST_SECRET/)
    process.env['TEST_SECRET'] = 'short'
    assert.throws(() => secretFromEnvironment('TEST_SECRET', 'dev'), /at least 32 characters/)
    process.env['TEST_SECRET'] = 'x'.repeat(32)
    assert.strictEqual(secretFromEnvironment('TEST_SECRET', 'dev'), 'x'.repeat(32))
  })
})
