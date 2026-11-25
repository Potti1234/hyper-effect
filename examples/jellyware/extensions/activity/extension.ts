import { Effect, Layer } from 'effect'

import { PageHost } from '@hyper-effect/core'
import { Contributions, ExtensionIslands } from '@hyper-effect/jellyware'

import { extension, pageOptions } from '#app/extensions'

import { PATH, makeProgram } from './page.ts'

/* Activity: a page /activity with a calendar of the workspace's activity.
   The calendar is this extension's own island (calendar.island.ts): browser
   code the app bundles for each version and runs in a sandboxed frame
   without network; the page sends it the days and gets back the day
   clicked. */

export default extension(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const islands = yield* ExtensionIslands
      const calendar = yield* islands.src('calendar')
      const pages = yield* PageHost
      yield* pages.mount(makeProgram(calendar), { ...pageOptions, path: PATH })
      const contributions = yield* Contributions
      yield* contributions.nav({ id: 'activity', label: 'Activity', href: PATH, icon: 'calendar-days' })
    }),
  ),
)
