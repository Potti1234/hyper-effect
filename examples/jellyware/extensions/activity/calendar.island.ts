import { runIsland } from '@hyper-effect/jellyware/island'

import { makeCalendar } from './calendar.ts'
import { Calendar } from './contract.ts'

/* The calendar island's entry, bundled for its frame (extension.json's
   "islands"). */

runIsland(Calendar, makeCalendar)
