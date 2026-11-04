/* Ordered intake: the order in which a session applies the events a page
   posts. Pure, so it can be tested against its specification
   (test/intake.test.ts); the session (session.ts) drives it and arms a timer
   for its deadline.

   Every event carries the page's sequence number (`q`). Requests overtake
   each other, get lost and are retried, so the session must:
   - apply events in sequence order, holding (parking) early arrivals;
   - give up on a missing event after a timeout (the request was lost) and go
     on, while still applying it once if it turns up late;
   - apply every event at most once, whatever the network repeats;
   - never hold an event forever: every gap is either filled or skipped.

   Sequence numbers below `next` were either applied or skipped. A skipped
   one is remembered (`skipped`), so its late arrival is applied once; any
   other number below `next` is a repeat and is dropped. */

/** How long a gap may block the events behind it. */
export const GAP_TIMEOUT_MILLIS = 1500

/** Skipped sequence numbers remembered for late arrivals. */
const MAX_SKIPPED = 256

/** Parked events beyond which the gap is skipped at once, so a client
 *  cannot make the session hold an unbounded number of events. */
const MAX_PARKED = 64

/** When a session starts without knowing its position (recreated from its
 *  URL), it learns it from the first event; this many numbers before that
 *  one are accepted once, since some may still be in flight. */
const LEARN_WINDOW = 32

export type Intake<A> = Readonly<{
  /** The next sequence number to apply; undefined until it is known. */
  next: number | undefined
  /** Early arrivals by sequence number. */
  parked: ReadonlyMap<number, A>
  /** Numbers passed over by a skip or before a learned position, in
   *  ascending order: their events are applied once if they arrive. */
  skipped: ReadonlySet<number>
  /** Since when the current gap has blocked parked events. */
  blockedSince: number | undefined
}>

export type Delivery<A> = Readonly<{
  sequence: number | undefined
  item: A
  /** Applied after its gap was skipped, so out of order. */
  late: boolean
}>

export type Step<A> = Readonly<{
  intake: Intake<A>
  delivered: ReadonlyArray<Delivery<A>>
  /** The event repeated one that was applied or is already parked. */
  repeated: boolean
  /** Sequence numbers skipped by this step. */
  skippedNow: ReadonlyArray<number>
}>

/** A fresh intake; `next` is known for a new page (1) or a restored
 *  snapshot, unknown for a session recreated from its URL. A restored one
 *  also gets the skipped numbers back: their late events must still be
 *  applied, not taken for repeats. */
export const make = <A>(next?: number, skipped: Iterable<number> = []): Intake<A> => ({
  next,
  parked: new Map(),
  skipped: new Set(skipped),
  blockedSince: undefined,
})

/** When the current gap will be skipped, if anything is waiting. */
export const deadline = <A>(intake: Intake<A>): number | undefined =>
  intake.blockedSince === undefined ? undefined : intake.blockedSince + GAP_TIMEOUT_MILLIS

const remember = (skipped: ReadonlySet<number>, numbers: Iterable<number>): ReadonlySet<number> => {
  const next = new Set(skipped)
  for (const number of numbers) next.add(number)
  // Oldest first: Sets iterate in insertion order, and numbers only grow.
  for (const number of next) {
    if (next.size <= MAX_SKIPPED) break
    next.delete(number)
  }
  return next
}

const range = (from: number, to: number): ReadonlyArray<number> =>
  Array.from({ length: Math.max(0, to - from) }, (_, index) => from + index)

/** Applies every parked event that is now next in line. */
const drain = <A>(
  intake: Intake<A>,
  now: number,
): Readonly<{ intake: Intake<A>; delivered: ReadonlyArray<Delivery<A>> }> => {
  let next = intake.next
  if (next === undefined) return { intake, delivered: [] }
  const parked = new Map(intake.parked)
  const delivered: Array<Delivery<A>> = []
  while (parked.has(next)) {
    const item = parked.get(next) as A
    parked.delete(next)
    delivered.push({ sequence: next, item, late: false })
    next += 1
  }
  // Whatever still waits now waits for a new gap; its clock starts when the
  // previous gap closed, not when the first of them arrived.
  const blockedSince =
    parked.size === 0 ? undefined : delivered.length > 0 ? now : (intake.blockedSince ?? now)
  return { intake: { ...intake, next, parked, blockedSince }, delivered }
}

/** Skips the gap in front of the earliest parked event and drains. */
const skipGap = <A>(intake: Intake<A>, now: number): Step<A> => {
  const earliest = Math.min(...intake.parked.keys())
  if (!Number.isFinite(earliest) || intake.next === undefined) {
    return { intake: { ...intake, blockedSince: undefined }, delivered: [], repeated: false, skippedNow: [] }
  }
  const skippedNow = range(Math.max(intake.next, earliest - MAX_SKIPPED), earliest)
  const skipped = remember(intake.skipped, skippedNow)
  const drained = drain({ ...intake, next: earliest, skipped, blockedSince: undefined }, now)
  return { ...drained, repeated: false, skippedNow }
}

/** Whether an event with this number would be dropped as a repeat: applied
 *  already, or parked already. */
export const isRepeat = <A>(intake: Intake<A>, sequence: number | undefined): boolean =>
  sequence !== undefined &&
  intake.next !== undefined &&
  ((sequence < intake.next && !intake.skipped.has(sequence)) || intake.parked.has(sequence))

/** An event arrives. Unnumbered events are applied at once. */
export const receive = <A>(
  intake: Intake<A>,
  sequence: number | undefined,
  item: A,
  now: number,
): Step<A> => {
  const nothing = (repeated: boolean, state = intake): Step<A> => ({
    intake: state,
    delivered: [],
    repeated,
    skippedNow: [],
  })
  if (sequence === undefined) {
    return { intake, delivered: [{ sequence, item, late: false }], repeated: false, skippedNow: [] }
  }
  let current = intake
  if (current.next === undefined) {
    // Learn the position; earlier numbers may still be in flight.
    current = {
      ...current,
      next: sequence,
      skipped: remember(current.skipped, range(Math.max(1, sequence - LEARN_WINDOW), sequence)),
    }
  }
  const next = current.next as number
  if (sequence < next) {
    if (!current.skipped.has(sequence)) return nothing(true, current)
    const skipped = new Set(current.skipped)
    skipped.delete(sequence)
    return {
      intake: { ...current, skipped },
      delivered: [{ sequence, item, late: true }],
      repeated: false,
      skippedNow: [],
    }
  }
  if (current.parked.has(sequence)) return nothing(true, current)
  const parked = new Map(current.parked)
  parked.set(sequence, item)
  const drained = drain({ ...current, parked }, now)
  if (drained.intake.parked.size > MAX_PARKED) {
    const skipped = skipGap(drained.intake, now)
    return { ...skipped, delivered: [...drained.delivered, ...skipped.delivered] }
  }
  return { ...drained, repeated: false, skippedNow: [] }
}

/** Time passes: at the deadline, the blocking gap is skipped. */
export const expire = <A>(intake: Intake<A>, now: number): Step<A> => {
  const due = deadline(intake)
  if (due === undefined || now < due) {
    return { intake, delivered: [], repeated: false, skippedNow: [] }
  }
  return skipGap(intake, now)
}
