import { Effect, Layer } from 'effect'

import { PageHost } from '@hyper-effect/core'
import { Contributions } from '@hyper-effect/jellyware'

import { extension, pageOptions } from '#app/extensions'

import * as TeamMap from './page.ts'

/* Team map: a page /team-map with a map of where the team works (the map
   widget, an island the app ships). Where each member works lives in the
   extension's own table (`places`, from the migrations in extension.json). */

export default extension(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const pages = yield* PageHost
      yield* pages.mount(TeamMap.program, { ...pageOptions, path: TeamMap.PATH })
      const contributions = yield* Contributions
      yield* contributions.nav({ id: 'team-map', label: 'Team map', href: TeamMap.PATH, icon: 'map' })
    }),
  ),
)
