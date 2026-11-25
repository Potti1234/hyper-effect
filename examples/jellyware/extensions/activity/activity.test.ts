import { assert, describe, it } from '@effect/vitest'
import { Story } from 'foldkit/test'

import { SEED_MEMBERS, seed } from '#app/seed'

import { Emit, Message as CalendarMessage, init as initCalendar, stepOf, update as updateCalendar } from './calendar.ts'
import { CalendarEvent } from './contract.ts'
import { DAY, activityOn, daysOf } from './days.ts'
import { Message, dataOf, update } from './page.ts'

/* The days of the calendar, the island's keys and clicks, and what the
   page accepts from it. */

const now = Date.UTC(2026, 10, 25, 12)
const state = seed(now)

describe('activity days', () => {
  it('covers whole weeks from a Monday, and counts changes and issues done', () => {
    const days = daysOf(state.activity, now, 4)
    assert.strictEqual(days.length, 28)
    assert.strictEqual(new Date(`${days[0]!.date}T00:00:00Z`).getUTCDay(), 1)
    assert.isTrue(days.some(day => day.date === '2026-11-25'))
    const counted = days.reduce((sum, day) => sum + day.changes, 0)
    const start = Date.parse(`${days[0]!.date}T00:00:00Z`)
    assert.strictEqual(counted, state.activity.filter(entry => entry.at >= start && entry.at < start + 28 * DAY).length)
    const busy = days.find(day => day.changes > 0)!
    assert.isTrue(activityOn(state.activity, busy.date).length === busy.changes)
  })

  it('shades a day by its share of the busiest', () => {
    assert.strictEqual(stepOf(0, 10), 0)
    assert.strictEqual(stepOf(1, 10), 1)
    assert.strictEqual(stepOf(10, 10), 4)
  })
})

describe('calendar island (Story)', () => {
  const days = daysOf(state.activity, now, 2)
  it('moves with the keys and reports the day clicked', () => {
    Story.story(
      updateCalendar,
      Story.given(initCalendar({ days, selected: null }).model),
      Story.message(CalendarMessage.PressedKey({ key: 'ArrowLeft' })),
      Story.model(next => assert.strictEqual(next.active, days.length - 1 - 7)),
      Story.message(CalendarMessage.PressedKey({ key: 'ArrowUp' })),
      Story.model(next => assert.strictEqual(next.active, days.length - 9)),
      Story.message(CalendarMessage.PressedKey({ key: 'Enter' })),
      Story.Command.expectExact(Emit({ event: CalendarEvent.members[0].make({ date: days[days.length - 9]!.date }) })),
      Story.Command.resolve(Emit, CalendarMessage.CompletedEmit()),
    )
  })
})

describe('activity page (Story)', () => {
  it('selects only days the calendar shows', () => {
    const shell = { me: SEED_MEMBERS[0]!, counts: { my: 0, ENG: 0, DES: 0 }, nav: [] }
    const data = dataOf({ ...state, version: 0, members: SEED_MEMBERS }, now)
    Story.story(
      update,
      Story.given({ shell, data, selected: null }),
      Story.message(Message.ClickedDay({ date: '1999-01-01' })),
      Story.model(next => assert.isNull(next.selected)),
      Story.message(Message.ClickedDay({ date: '2026-11-25' })),
      Story.model(next => assert.strictEqual(next.selected, '2026-11-25')),
      Story.message(Message.ClickedClear()),
      Story.model(next => assert.isNull(next.selected)),
    )
  })
})
