import { Effect, Layer } from 'effect'
import { PageHost } from '@hyper-effect/core'
import { Contributions } from '@hyper-effect/jellyware'
import { extension, pageOptions } from '#app/extensions'
import * as Triage from './page.ts'

export default extension(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const pages = yield* PageHost
      yield* pages.mount(Triage.program, { ...pageOptions, path: Triage.PATH })
      const contributions = yield* Contributions
      yield* contributions.nav({ id: 'triage', label: 'Triage', href: Triage.PATH, icon: 'inbox' })
    }),
  ),
)
