/* Browser entry for the islands bundle (built by Vite into public/assets). */
import { register } from '@hyper-effect/island/client'

import { IncidentMap } from '@/app/dispatch/islands/incident-map'
import { makeIncidentMap } from '@/app/dispatch/islands/incident-map.client'

register(IncidentMap, makeIncidentMap)
