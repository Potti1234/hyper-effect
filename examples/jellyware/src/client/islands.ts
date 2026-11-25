/* Browser entry of the islands bundle (built by Vite into public/assets):
   the app's widgets, which any page renders with `chart` and `map` from
   src/app/widgets. */
import { register } from '@hyper-effect/island/client'

import { Chart } from '#app/widgets/chart-contract'
import { makeChart } from '#app/widgets/chart.client'
import { PlaceMap } from '#app/widgets/map-contract'
import { makeMap } from '#app/widgets/map.client'

register(Chart, makeChart)
register(PlaceMap, makeMap)
