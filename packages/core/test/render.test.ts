import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'

import type { Binder } from '../src/binding'
import { renderModel } from '../src/session'

import { program } from './fixtures/greeter'

const binder: Binder<never> = {
  endpoint: '/_hyper/test/s/1',
  bindMessage: message => `m: '${Buffer.from(JSON.stringify(message)).toString('base64url')}'`,
  registerHandler: () => 'a.0',
  registerInput: () => {},
}

describe('production render path', () => {
  it.effect('serializes exactly what the validated render produces', () =>
    Effect.gen(function* () {
      const model = {
        ...program.init().model,
        name: 'Quotes " and <tags> & ampersands',
        greetings: ['<b>bold</b>', "it's"],
      }
      /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
      const anyProgram = program as never
      const validated = yield* renderModel(anyProgram, model, binder, { validate: true })
      const direct = yield* renderModel(anyProgram, model, binder, { validate: false })
      assert.strictEqual(direct.html, validated.html)
      assert.strictEqual(direct.title, validated.title)
    }),
  )
})
