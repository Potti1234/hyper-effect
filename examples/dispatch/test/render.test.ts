import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'

import { type Binder, renderModel } from '@hyper-effect/core/testing'

import * as Board from '@/app/dispatch/board'
import * as Greeter from '@/app/greeter'

const binder: Binder<never> = {
  endpoint: '/_hyper/test/s/1',
  bindMessage: message => `m: '${Buffer.from(JSON.stringify(message)).toString('base64url')}'`,
  registerHandler: () => 'a.0',
  registerInput: () => {},
}

describe('production render path', () => {
  it.effect('serializes exactly what the validated render produces', () =>
    Effect.gen(function* () {
      const cases = [
        [Greeter.program, Greeter.program.init().model],
        [
          Board.program,
          Board.init({
            me: 'Test 1',
            version: 'render-test.1',
            incidents: [
              {
                id: 'INC-1',
                title: 'Quotes " and <tags> & ampersands',
                severity: 'high',
                status: 'open',
                location: { longitude: 11.5, latitude: 48.1 },
                assignee: null,
                createdAt: 0,
                comments: [],
              },
            ],
            activity: [],
          }).model,
        ],
      ] as const
      for (const [program, model] of cases) {
        /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
        const anyProgram = program as never
        const validated = yield* renderModel(anyProgram, model, binder, { validate: true })
        const direct = yield* renderModel(anyProgram, model, binder, { validate: false })
        assert.strictEqual(direct.html, validated.html)
        assert.strictEqual(direct.title, validated.title)
      }
    }),
  )
})
