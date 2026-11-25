import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { KeyValueStore } from 'effect/persistence'

import { type HostedPage, PageHost, PageOwner } from '@hyper-effect/core'

import { Contributions } from '../src/contributions'
import { graph } from '../src/graft'
import { guide } from '../src/guide'
import { Extensions, layer } from '../src/loader'

/* The guide for the agent, from a running loader: what each extension adds
   is credited to it, and an extension that failed shows its error. */

const directory = join(import.meta.dirname, '.tmp', `guide-${Date.now()}`)
mkdirSync(directory, { recursive: true })
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const contributionsModule = join(import.meta.dirname, '..', 'src', 'contributions.ts').replaceAll('\\', '/')

const write = (id: string, body: string, manifest: Record<string, unknown> = {}) => {
  mkdirSync(join(directory, id), { recursive: true })
  writeFileSync(
    join(directory, id, 'extension.json'),
    JSON.stringify({ id, name: `Extension ${id}`, version: '1', entry: 'extension.ts', ...manifest }),
  )
  writeFileSync(join(directory, id, 'extension.ts'), body)
}

write(
  'related',
  `
import { Effect, Layer, Stream } from 'effect'
import { PageHost } from '@hyper-effect/core'
import { Contributions } from '${contributionsModule}'

export default Layer.effectDiscard(
  Effect.gen(function* () {
    const contributions = yield* Contributions
    yield* contributions.nav({ id: 'related', label: 'Related', href: '/related', icon: 'link' })
    yield* contributions.slot({ slot: 'issue.sidebar', id: 'related', content: () => Stream.never })
    yield* contributions.command({ id: 'related.close', roles: ['admin'], run: () => Effect.succeed('Closed') })
    yield* (yield* PageHost).mount({ name: 'related' })
  }),
)
`,
  {
    description: 'Shows issues related to the one open.',
    settings: { max: { type: 'number', label: 'Issues shown', default: 5, min: 1, max: 10 } },
  },
)
write('broken', `export default Layer.effectDiscard(Effect.fail('no database'))\nimport { Effect, Layer } from 'effect'\n`)

// A page host that records who mounts what.
const mounted: Array<HostedPage> = []
const host = Layer.succeed(
  PageHost,
  PageHost.of({
    mount: program =>
      Effect.flatMap(PageOwner, owner =>
        Effect.sync(() => {
          mounted.push({ name: program.name, paths: [`/${program.name}`], owner })
        }),
      ),
    mountRoutes: () => Effect.void,
    names: Effect.sync(() => mounted.map(page => page.name)),
    pages: Effect.sync(() => mounted),
  }),
)

const app = layer({ directory, requires: [Contributions, PageHost] }).pipe(
  Layer.provideMerge(graph),
  Layer.provideMerge(Contributions.layer),
  Layer.provideMerge(host),
  Layer.provideMerge(KeyValueStore.layerMemory),
)

describe('guide', () => {
  it.live('describes pages, slots, commands, entries and extensions, each with its owner', () =>
    Effect.gen(function* () {
      // Wait until both extensions are past loading.
      for (let i = 0; i < 200; i++) {
        const states = (yield* Extensions.use(each => each.current)).map(status => status.state)
        if (states.length === 2 && states.every(state => state === 'active' || state === 'failed')) break
        yield* Effect.sleep('25 millis')
      }
      // The app's own command, registered outside any extension.
      yield* Contributions.use(contributions => contributions.command({ id: 'app.archive', run: () => Effect.succeed('') }))

      const text = yield* guide({
        appPages: [{ name: 'issue', paths: ['/issue/:identifier'] }, { name: null, paths: ['/login'] }],
        slots: [{ name: 'issue.sidebar', where: "under an issue's properties", how: 'Use `issueSidebar`.' }],
      })
      const expected = [
        '- `/issue/:identifier`: page `issue` (the app)',
        '- `/login` (the app)',
        '- `/related`: page `related` (`related/`)',
        "- `issue.sidebar`, under an issue's properties. Use `issueSidebar`.",
        '  In it now: `related` (`related/`).',
        '- `related.close` (`related/`): only `admin`',
        '- `app.archive` (the app): every member who sees its button',
        '- `related`: "Related", icon `link`, links to `/related` (`related/`)',
        '### `related/`: Extension related, version 1, running',
        'Shows issues related to the one open.',
        '- Adds: page `related` at `/related`; sidebar entry `related`; card `related` in `issue.sidebar`; command `related.close`.',
        '- Settings: `max` (number 1–10; label: Issues shown) is 5.',
        '### `broken/`: Extension broken, version 1, failed',
        '- Adds: nothing while it does not run.',
      ]
      for (const line of expected) assert.include(text, line)
      assert.include(text, 'no database')
    }).pipe(Effect.scoped, Effect.provide(app)),
  )
})
