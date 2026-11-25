import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'

import { checkFolder } from '@hyper-effect/jellyware'

import { importRules } from '@/app/extension-rules'
import { type Guard, decide, parseGuard } from '@/pi-guard'

/* The rules for what a run may produce and touch: every extension in
   extensions/ follows the import rules, and the pi guard keeps the agent's
   file tools in the stage (writes) and the repository (reads). */

const extensions = fileURLToPath(new URL('../extensions', import.meta.url))

describe('import rules', () => {
  for (const id of ['standup', 'related', 'triage', 'progress', 'stale', 'pins']) {
    it.effect(`${id} follows them`, () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* checkFolder(join(extensions, id), importRules), [])
      }),
    )
  }
})

describe('pi guard', () => {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '.tmp', `guard-${Date.now()}`)
  const repository = join(root, 'repo')
  const stage = join(repository, 'app', '.jellyware', 'runs', 'r1', 'stage')
  mkdirSync(join(stage, 'standup'), { recursive: true })
  mkdirSync(join(repository, 'app', 'src'), { recursive: true })
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const guard: Guard = { stage, read: [repository], hidden: ['.jellyware', '.git', '.env*'] }
  const call = (tool: string, input: Record<string, unknown>) => decide(tool, input, guard, stage)
  const blocked = (tool: string, input: Record<string, unknown>) => call(tool, input).block

  it('lets the agent write in the stage, and gives pi the checked path', () => {
    const decision = call('write', { path: 'standup/page.ts', content: '' })
    assert.deepStrictEqual(decision, { block: false, path: join(stage, 'standup', 'page.ts') })
    assert.isFalse(blocked('edit', { path: join(stage, 'new', 'extension.ts') }))
    assert.isFalse(blocked('ls', {}))
  })

  it('refuses writes outside the stage, however the path is spelled', () => {
    assert.isTrue(blocked('write', { path: '../../../../src/main.ts', content: '' }))
    assert.isTrue(blocked('edit', { path: join(repository, 'app', 'src', 'main.ts') }))
    assert.isTrue(blocked('write', { path: '~/notes.txt', content: '' }))
    assert.isTrue(blocked('write', { path: '@../stage-sibling.ts', content: '' }))
    assert.isTrue(blocked('write', { path: `${stage}-other/x.ts`, content: '' }))
  })

  it('lets the agent read the repository, but not run folders, git or .env files', () => {
    assert.isFalse(blocked('read', { path: join(repository, 'app', 'src', 'app', 'extensions.ts') }))
    assert.isFalse(blocked('grep', { pattern: 'region', path: join(repository, 'app', 'src') }))
    assert.isTrue(blocked('read', { path: '../../../pi-agent/auth.json' }))
    assert.isTrue(blocked('read', { path: join(repository, 'app', '.jellyware', 'runs', 'r0', 'stage', 'x.ts') }))
    assert.isTrue(blocked('read', { path: join(repository, '.git', 'config') }))
    assert.isTrue(blocked('read', { path: join(repository, 'app', '.env.local') }))
    assert.isTrue(blocked('read', { path: join(homedir(), '.codex', 'auth.json') }))
    assert.isTrue(blocked('find', { pattern: '*', path: root }))
  })

  it('refuses other tools and paths that are not strings', () => {
    assert.isTrue(blocked('bash', { command: 'ls' }))
    assert.isTrue(blocked('read', { path: 42 }))
  })

  it('reads its configuration only when it is complete', () => {
    assert.deepStrictEqual(parseGuard(JSON.stringify(guard)), guard)
    assert.isNull(parseGuard(undefined))
    assert.isNull(parseGuard('{'))
    assert.isNull(parseGuard(JSON.stringify({ stage, read: [repository] })))
  })

  it('follows symbolic links before deciding', ctx => {
    const outside = join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'x')
    try {
      symlinkSync(outside, join(stage, 'link'), 'junction')
    } catch {
      ctx.skip()
    }
    assert.isTrue(blocked('write', { path: 'link/secret.txt', content: '' }))
    assert.isTrue(blocked('read', { path: 'link/secret.txt' }))
  })
})
