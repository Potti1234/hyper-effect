import { Schema as S } from 'effect'

/* A network simulation for the ordered intake: a page sends events 1..N, the
   network delays, loses and repeats them, and the intake receives them in
   arrival order while its deadlines fire in between. Generic over the
   implementation, so the same properties can be run against any intake. */

export type IntakeImplementation<State> = Readonly<{
  make: (next?: number) => State
  receive: (
    state: State,
    sequence: number,
    item: number,
    now: number,
  ) => Readonly<{ intake: State; delivered: ReadonlyArray<Readonly<{ sequence: number | undefined; late: boolean }>> }>
  expire: (
    state: State,
    now: number,
  ) => Readonly<{ intake: State; delivered: ReadonlyArray<Readonly<{ sequence: number | undefined; late: boolean }>> }>
  deadline: (state: State) => number | undefined
  parkedCount: (state: State) => number
}>

const millis = (maximum: number) =>
  S.Number.check(S.isInt(), S.isBetween({ minimum: 0, maximum }))

/** What happens to one event: sent `gap` ms after the previous one, arriving
 *  `delay` ms later; `fate` 0 loses it, 1 sends it twice (the second copy
 *  `retryDelay` ms after the first), anything else delivers it once. */
export const Fate = S.Struct({
  gap: millis(400),
  delay: millis(3000),
  fate: S.Number.check(S.isInt(), S.isBetween({ minimum: 0, maximum: 9 })),
  retryDelay: millis(3000),
})
export type Fate = typeof Fate.Type

export const Scenario = S.Array(Fate).check(S.isBetweenLength(1, 25))

/** A good network: nothing lost or repeated, every delay under half the gap
 *  timeout, so no gap ever needs skipping. */
export const GoodNetwork = S.Array(S.Struct({ gap: millis(400), delay: millis(700) })).check(
  S.isBetweenLength(1, 25),
)

export type Outcome = Readonly<{
  deliveries: ReadonlyArray<Readonly<{ sequence: number; late: boolean; at: number }>>
  /** First arrival time of every event that arrived at least once. */
  arrivals: ReadonlyMap<number, number>
  /** Events still parked when nothing more arrives and no deadline is due. */
  parkedAtEnd: number
}>

export const simulate = <State>(
  implementation: IntakeImplementation<State>,
  fates: ReadonlyArray<Fate>,
): Outcome => {
  const sends: Array<Readonly<{ sequence: number; at: number }>> = []
  let sentAt = 0
  fates.forEach((fate, index) => {
    sentAt += fate.gap
    const sequence = index + 1
    if (fate.fate !== 0) sends.push({ sequence, at: sentAt + fate.delay })
    if (fate.fate === 1) sends.push({ sequence, at: sentAt + fate.delay + fate.retryDelay })
  })
  const queue = [...sends].sort((a, b) => a.at - b.at || a.sequence - b.sequence)
  const arrivals = new Map<number, number>()
  for (const { sequence, at } of queue) if (!arrivals.has(sequence)) arrivals.set(sequence, at)

  const deliveries: Array<Readonly<{ sequence: number; late: boolean; at: number }>> = []
  let state = implementation.make(1)
  let index = 0
  for (let steps = 0; steps < 10_000; steps += 1) {
    const due = implementation.deadline(state)
    const arrival = queue[index]
    if (arrival === undefined && due === undefined) break
    const isExpiry = due !== undefined && (arrival === undefined || due <= arrival.at)
    const now = isExpiry ? (due as number) : (arrival as { at: number }).at
    const step = isExpiry
      ? implementation.expire(state, now)
      : implementation.receive(state, (arrival as { sequence: number }).sequence, 0, now)
    if (!isExpiry) index += 1
    for (const delivery of step.delivered) {
      deliveries.push({ sequence: delivery.sequence ?? -1, late: delivery.late, at: now })
    }
    state = step.intake
  }
  return { deliveries, arrivals, parkedAtEnd: implementation.parkedCount(state) }
}
