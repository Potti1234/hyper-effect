import { Schema as S } from 'effect'

import { defineIsland } from '@hyper-effect/jellyware/island'

/* The calendar island's contract, shared by the page (server) and the
   island (browser, in its frame). */

export const Day = S.Struct({
  /** yyyy-mm-dd, UTC. */
  date: S.String,
  /** Changes to issues that day. */
  changes: S.Number,
  /** Issues moved to Done that day. */
  done: S.Number,
})
export type Day = typeof Day.Type

export const CalendarProps = S.Struct({
  /** Every day shown, oldest first, starting on a Monday. */
  days: S.Array(Day),
  selected: S.NullOr(S.String),
})
export type CalendarProps = typeof CalendarProps.Type

export const CalendarEvent = S.Union([S.TaggedStruct('ClickedDay', { date: S.String })])
export type CalendarEvent = typeof CalendarEvent.Type

export const Calendar = defineIsland({ name: 'calendar', Props: CalendarProps, Event: CalendarEvent })
