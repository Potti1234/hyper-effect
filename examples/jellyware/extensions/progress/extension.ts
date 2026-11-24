import { Effect, Layer } from 'effect'
import { PageHost } from '@hyper-effect/core'
import { Contributions, ExtensionSettings } from '@hyper-effect/jellyware'
import { extension, pageOptions } from '#app/extensions'
import { PATH, makeProgram } from './page.ts'

export default extension(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const settings = yield* ExtensionSettings
      const days = Math.max(7, Math.min(180, Math.round(settings.number('defaultDays'))))
      const pages = yield* PageHost
      yield* pages.mount(makeProgram(days), { ...pageOptions, path: PATH })
      const contributions = yield* Contributions
      yield* contributions.nav({ id: 'progress', label: 'Progress', href: PATH, icon: 'chart-no-axes-combined' })
    }),
  ),
)
