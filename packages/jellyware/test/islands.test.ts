import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, assert, describe, it } from '@effect/vitest'
import { type Context, Effect, Layer, Option } from 'effect'
import { KeyValueStore } from 'effect/persistence'

import { Contributions } from '../src/contributions'
import { graph } from '../src/graft'
import { buildIsland, framePage } from '../src/islands/build'
import { fromFrame, toFrame } from '../src/islands/contract'
import { Extensions, layer } from '../src/loader'

/* Extensions' own browser code: built per version, served in a frame with
   a policy that allows no network, and handed to the extension by name. */

const directory = join(import.meta.dirname, '.tmp', `islands-${Date.now()}`)
mkdirSync(directory, { recursive: true })
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const contributionsModule = join(import.meta.dirname, '..', 'src', 'contributions.ts').replaceAll('\\', '/')
const viewModule = join(import.meta.dirname, '..', 'src', 'islands', 'view.ts').replaceAll('\\', '/')

const write = (id: string, files: Readonly<Record<string, string>>, islands: Readonly<Record<string, string>>) => {
  mkdirSync(join(directory, id), { recursive: true })
  writeFileSync(join(directory, id, 'extension.json'), JSON.stringify({ id, name: id, version: '1', entry: 'extension.ts', islands }))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, id, name), text)
}

/** An extension that puts its island's address into a sidebar entry. */
const entry = (island: string) => `
import { Effect, Layer } from 'effect'
import { Contributions } from '${contributionsModule}'
import { ExtensionIslands } from '${viewModule}'

export default Layer.effectDiscard(
  Effect.gen(function* () {
    const src = yield* (yield* ExtensionIslands).src('${island}')
    yield* (yield* Contributions).nav({ id: 'nav', label: src, href: '/x', icon: 'star' })
  }),
)
`

write('drawn', { 'extension.ts': entry('board'), 'board.ts': "import { mark } from './mark.ts'\ndocument.title = mark('board')\n", 'mark.ts': 'export const mark = (text: string) => `<${text}>`\n' }, { board: 'board.ts' })
write('broken', { 'extension.ts': entry('board'), 'board.ts': 'export const = 1\n' }, { board: 'board.ts' })
write('misnamed', { 'extension.ts': entry('other'), 'board.ts': 'export {}\n' }, { board: 'board.ts' })
write('escaping', { 'extension.ts': entry('board') }, { board: '../drawn/board.ts' })

const app = layer({ directory, requires: [Contributions] }).pipe(
  Layer.provideMerge(graph),
  Layer.provideMerge(Contributions.layer),
  Layer.provideMerge(KeyValueStore.layerMemory),
)

let context: Context.Context<Extensions | Contributions>
const run = <A, E>(effect: Effect.Effect<A, E, Extensions | Contributions>) => Effect.runPromise(Effect.provide(effect, context))
const status = (id: string) => run(Effect.flatMap(Extensions, extensions => extensions.current)).then(list => list.find(each => each.id === id))

describe('islands', () => {
  it('builds an extension’s islands per version and gives it their frames', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        context = yield* Layer.build(app)
        yield* Effect.promise(async () => {
          const drawn = await status('drawn')
          assert.strictEqual(drawn?.state, 'active')
          assert.deepStrictEqual(drawn?.islands, ['board'])
          const [nav] = await run(Effect.flatMap(Contributions, contributions => contributions.navEntries))
          const match = /^\/_jellyware\/islands\/drawn\/board\/([0-9a-f]{16})$/.exec(nav?.label ?? '')
          assert.isNotNull(match, nav?.label)
          const code = await run(Effect.flatMap(Extensions, extensions => extensions.islandCode('drawn', 'board', match![1]!)))
          assert.isTrue(Option.isSome(code) && code.value.includes('document.title'))
          assert.isTrue(Option.isNone(await run(Effect.flatMap(Extensions, extensions => extensions.islandCode('drawn', 'board', '0000000000000000')))))

          const broken = await status('broken')
          assert.strictEqual(broken?.state, 'failed')
          assert.include(broken?.error ?? '', 'The island "board" (board.ts) did not build')
          assert.strictEqual((await status('misnamed'))?.state, 'failed')
          assert.include((await status('misnamed'))?.error ?? '', 'There is no island "other"')
          assert.include((await status('escaping'))?.error ?? '', "must be a file in the extension's folder")
        })
      }).pipe(Effect.scoped),
    )
  }, 30_000)
})

describe('frames', () => {
  it('runs only its own script, with no network, and cannot be closed early', async () => {
    const { code } = await Effect.runPromise(buildIsland(join(directory, 'drawn', 'board.ts')))
    const page = framePage(`${code}\nconst x = "</script><script>alert(1)</script>"`, { origin: 'http://app.test', stylesheets: ['/styles.css'] })
    const nonce = /nonce="([^"]+)"/.exec(page.html)?.[1] ?? ''
    assert.include(page.policy, `script-src 'nonce-${nonce}'`)
    assert.include(page.policy, "connect-src 'none'")
    assert.include(page.policy, "default-src 'none'")
    assert.include(page.html, '<link rel="stylesheet" href="http://app.test/styles.css">')
    // The code cannot end its script element: only the real end remains.
    assert.strictEqual(page.html.split('</script').length - 1, 1)
    assert.isTrue(page.html.trimEnd().endsWith('</script></body></html>'))
  })

  it('accepts only the messages of the protocol', () => {
    assert.deepStrictEqual(fromFrame({ type: 'height', height: 120 }), { type: 'height', height: 120 })
    assert.isNull(fromFrame({ type: 'height', height: 'tall' }))
    assert.isNull(fromFrame({ type: 'navigate', to: '/' }))
    assert.isNull(fromFrame('ready'))
    assert.deepStrictEqual(toFrame({ type: 'theme', dark: 'yes' }), { type: 'theme', dark: false })
  })
})
