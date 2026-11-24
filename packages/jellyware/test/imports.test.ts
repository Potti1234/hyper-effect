import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'

import { findProblems, importCheck } from '../src/imports'

/* The import check: what an extension's code may reach. */

const rules = {
  allow: ['effect', 'foldkit', { module: '@hyper-effect/core', names: ['PageHost', 'region'] }, '#app/extensions', '#app/view/*'],
  deny: ['foldkit/experimental*'],
}
const folder = join(import.meta.dirname, '.tmp', `imports-${Date.now()}`)
const problemsOf = (source: string, file = 'extension.ts') => findProblems(source, join(folder, 'demo', file), join(folder, 'demo'), rules)
afterAll(() => rmSync(folder, { recursive: true, force: true }))

describe('imports', () => {
  it('accepts the allowed modules, their subpaths, files of the extension and type-only imports', () => {
    const problems = problemsOf(`
      import { Effect, Layer } from 'effect'
      import { html } from 'foldkit/html'
      import { PageHost, region as area, type Program } from '@hyper-effect/core'
      import type { Secret } from '@hyper-effect/core'
      import { extension } from '#app/extensions'
      import { Star } from '#app/view/icons'
      import type { Server } from 'node:http'
      import { page } from './page.ts'
      export { more } from './more/index.ts'
      const lazy = () => import('./lazy.ts')
      const model = { process: 'triage', fetch: 1 }
      const step = model.process
      type Hooks = { module: string; Function: () => void }
    `)
    assert.deepStrictEqual(problems, [])
  })

  it('refuses other modules, folders outside the extension, computed imports and process globals', () => {
    const problems = problemsOf(`
      import { readFile } from 'node:fs/promises'
      import { piAgent } from '#app/agent'
      import { FetchHttpClient } from 'effect-http'
      import secret from '../other/secret.ts'
      export * from 'node:child_process'
      const name = 'node:fs'
      const m = import(name)
      const env = process.env
      const g = globalThis
      const run = eval
      const f = new Function('return 1')
      fetch('https://example.com')
      const url = import.meta.url
      const shorthand = { process }
      const viaIndex = window['process']
      import { Config } from 'effect'
      import { fileStore, PageHost } from '@hyper-effect/core'
      import * as Hyper from '@hyper-effect/core'
      import { query } from 'foldkit/experimental/query'
    `)
    const expected = [
      'extension.ts:2: extensions may not import "node:fs/promises"',
      'extension.ts:3: extensions may not import "#app/agent"',
      'extension.ts:4: extensions may not import "effect-http"',
      `extension.ts:5: "../other/secret.ts" is outside the extension's folder.`,
      'extension.ts:6: extensions may not import "node:child_process"',
      'extension.ts:8: `import()` must name its module as a string.',
      'extension.ts:9: extensions may not use the global `process`.',
      'extension.ts:10: extensions may not use the global `globalThis`.',
      'extension.ts:11: extensions may not use the global `eval`.',
      'extension.ts:12: extensions may not use the global `Function`.',
      'extension.ts:13: extensions may not use the global `fetch`.',
      'extension.ts:14: extensions may not use `import.meta`.',
      'extension.ts:15: extensions may not use the global `process`.',
      'extension.ts:16: extensions may not use `process`.',
      'extension.ts:17: extensions may not use `Config`.',
      'extension.ts:18: extensions may not import fileStore from "@hyper-effect/core" (allowed: PageHost, region).',
      'extension.ts:19: import names from "@hyper-effect/core" one by one',
      'extension.ts:20: extensions may not import "foldkit/experimental/query"',
    ]
    assert.strictEqual(problems.length, expected.length, problems.join('\n'))
    expected.forEach((start, index) => assert.isTrue(problems[index]?.startsWith(start), `${problems[index]} should start with ${start}`))
  })

  it.effect('fails a run with every problem of the changed extensions', () =>
    Effect.gen(function* () {
      mkdirSync(join(folder, 'snapshot', 'good'), { recursive: true })
      mkdirSync(join(folder, 'snapshot', 'bad', 'lib'), { recursive: true })
      writeFileSync(join(folder, 'snapshot', 'good', 'extension.ts'), `import { Effect } from 'effect'\nexport default Effect.void\n`)
      writeFileSync(join(folder, 'snapshot', 'bad', 'extension.ts'), `import './lib/util.ts'\n`)
      writeFileSync(join(folder, 'snapshot', 'bad', 'lib', 'util.ts'), `export const env = process.env\n`)
      writeFileSync(join(folder, 'snapshot', 'bad', 'notes.md'), `process.env is not code\n`)
      const check = importCheck(rules)
      const run = (changed: ReadonlyArray<string>) =>
        check.run({ snapshot: join(folder, 'snapshot'), runDirectory: folder, changed }).pipe(Effect.flip, Effect.option)
      assert.strictEqual((yield* run(['good']))._tag, 'None')
      const failed = yield* run(['good', 'bad'])
      assert.isTrue(failed._tag === 'Some' && failed.value.startsWith('bad/lib/util.ts:1: extensions may not use the global `process`.'))
    }),
  )
})
