import type { Activity } from '#app/domain'

import type { Day } from './contract.ts'

/* The workspace's activity per day (UTC). */

export const DAY = 86_400_000

export const isoDay = (at: number) => new Date(at).toISOString().slice(0, 10)

/** The last `weeks` weeks up to the week of `now`, from a Monday, with the
 *  changes and the issues done each day. */
export const daysOf = (activity: ReadonlyArray<Activity>, now: number, weeks: number): ReadonlyArray<Day> => {
  const today = Math.floor(now / DAY) * DAY
  // Monday of this week (1970-01-01 was a Thursday).
  const monday = today - (((Math.floor(today / DAY) + 3) % 7) * DAY)
  const start = monday - (weeks - 1) * 7 * DAY
  const days = Array.from({ length: weeks * 7 }, (_, index) => ({ date: isoDay(start + index * DAY), changes: 0, done: 0 }))
  for (const entry of activity) {
    const index = Math.floor((entry.at - start) / DAY)
    const day = days[index]
    if (day === undefined) continue
    day.changes += 1
    if (entry.kind === 'status' && entry.text.endsWith(' to Done')) day.done += 1
  }
  return days
}

/** The activity of one day, newest first. */
export const activityOn = (activity: ReadonlyArray<Activity>, date: string): ReadonlyArray<Activity> =>
  activity.filter(entry => isoDay(entry.at) === date).sort((a, b) => b.at - a.at)
