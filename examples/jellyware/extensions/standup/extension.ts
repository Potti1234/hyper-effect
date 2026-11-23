import { Effect, Layer } from 'effect'

import { PageHost } from '@hyper-effect/core'
import { Contributions } from '@hyper-effect/jellyware'

import { extension, pageOptions } from '#app/extensions'

import * as Standup from './page.ts'

/* The Stand-up extension: a page at /standup and its sidebar entry. Both
   belong to this extension's scope; unloading it removes them, and a new
   version replaces them. */

export default extension(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const pages = yield* PageHost
      yield* pages.mount(Standup.program, { ...pageOptions, path: Standup.PATH })
      const contributions = yield* Contributions
      yield* contributions.nav({ id: 'standup', label: 'Stand-up', href: Standup.PATH, icon: 'coffee' })
    }),
  ),
)
