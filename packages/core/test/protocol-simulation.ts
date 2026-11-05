import { Schema as S } from 'effect'

import * as Intake from '../src/intake'

/* The delivery protocol end to end, across process failures: a page sends
   events 1..N and retries every request that fails (as Datastar does: after
   1 s, doubling, at most 10 times); the server applies them through the real
   intake (intake.ts), writes snapshots, and answers; at random times the
   process fails and another takes over from the last snapshot.

   The server side is a model of server.ts and session.ts, reduced to what
   decides delivery:
   - `durable`: an event is answered once it is applied and a snapshot
     written after that has completed; writes run one at a time, and the
     requests made during one share the next (server.ts `saveSnapshot`).
   - `debounced`: the old rule; answered once applied, snapshot a quiet
     second after the last change.
   - `keepSkipped`: whether a snapshot keeps the skipped sequence numbers
     along with the position.
   Applying is synchronous here, one event at a time; like session.ts, the
   applied events, the position and the skipped numbers change together, and
   a snapshot takes all three. */

const millis = (maximum: number) => S.Number.check(S.isInt(), S.isBetween({ minimum: 0, maximum }))

/** One event: sent `gap` ms after the previous one, each attempt arriving
 *  `delay` ms after it is sent. `fate` 0: the first attempt fails before it
 *  arrives; 1: the first attempt's answer is lost (the page sees a failure);
 *  anything else: no trouble. */
export const EventFate = S.Struct({
  gap: millis(400),
  delay: millis(600),
  fate: S.Number.check(S.isInt(), S.isBetween({ minimum: 0, maximum: 5 })),
})

export const FailureScenario = S.Struct({
  events: S.Array(EventFate).check(S.isBetweenLength(1, 20)),
  /** When the process fails. */
  failures: S.Array(millis(5000)).check(S.isBetweenLength(0, 3)),
  /** How long a snapshot write takes. */
  writeMillis: millis(60),
})
export type FailureScenario = typeof FailureScenario.Type

export type Rules = Readonly<{ durable: boolean; keepSkipped: boolean }>

export type FailureOutcome = Readonly<{
  /** Sequence numbers in the order the surviving process applied them. */
  history: ReadonlyArray<number>
  /** Events the page was answered for. */
  answered: ReadonlySet<number>
  /** Events the page gave up on after its last retry. */
  abandoned: ReadonlySet<number>
}>

type Snapshot = Readonly<{ history: ReadonlyArray<number>; position: number; skipped: ReadonlyArray<number> }>

type Happening =
  | Readonly<{ _tag: 'Send'; sequence: number; attempt: number }>
  | Readonly<{ _tag: 'Arrive'; sequence: number; attempt: number }>
  | Readonly<{ _tag: 'Answer'; sequence: number; attempt: number }>
  | Readonly<{ _tag: 'Fail'; sequence: number; attempt: number }>
  | Readonly<{ _tag: 'Deadline'; generation: number }>
  | Readonly<{ _tag: 'Written'; generation: number; snapshot: Snapshot; covered: ReadonlyArray<Request> }>
  | Readonly<{ _tag: 'Debounce'; generation: number; change: number }>
  | Readonly<{ _tag: 'Crash' }>

type Request = Readonly<{ sequence: number; attempt: number }>

const RETRY_MILLIS = 1000
const MAX_RETRIES = 10
const DEBOUNCE_MILLIS = 1000

export const simulateFailures = (scenario: FailureScenario, rules: Rules): FailureOutcome => {
  const agenda: Array<Readonly<{ at: number; order: number; happening: Happening }>> = []
  let order = 0
  const schedule = (at: number, happening: Happening) => {
    agenda.push({ at, order: (order += 1), happening })
  }

  // The page.
  const answered = new Set<number>()
  const abandoned = new Set<number>()
  const attempts = new Map<number, number>()
  let sentAt = 0
  scenario.events.forEach((event, index) => {
    sentAt += event.gap
    schedule(sentAt, { _tag: 'Send', sequence: index + 1, attempt: 1 })
  })
  for (const at of scenario.failures) schedule(at, { _tag: 'Crash' })
  const fateOf = (sequence: number) => scenario.events[sequence - 1]!

  // The process holding the session, and the shared store.
  let snapshot: Snapshot = { history: [], position: 1, skipped: [] }
  let generation = 0
  let intake = Intake.make<Request>(1)
  let history: Array<number> = []
  // The position and skipped numbers that go with `history`, changed with
  // every applied event, as session.ts keeps them with the Model.
  let position = 1
  let skipped: ReadonlySet<number> = new Set()
  /** Received, not applied yet: who waits for each. */
  let waiting = new Map<number, Array<Request>>()
  /** Applied, waiting for a write. */
  let unwritten: Array<Request> = []
  /** Covered by the write in progress, if any. */
  let writing: ReadonlyArray<Request> | undefined
  let change = 0

  const capture = (): Snapshot => ({
    history: [...history],
    position,
    skipped: rules.keepSkipped ? [...skipped] : [],
  })

  const answer = (request: Request, now: number) =>
    schedule(now + fateOf(request.sequence).delay, { _tag: 'Answer', ...request })

  const write = (now: number) => {
    if (writing !== undefined || unwritten.length === 0) return
    writing = unwritten
    unwritten = []
    schedule(now + scenario.writeMillis, { _tag: 'Written', generation, snapshot: capture(), covered: writing })
  }

  /** The event's requests are settled: answered now, or after a write. */
  const settle = (requests: ReadonlyArray<Request>, now: number) => {
    if (rules.durable) {
      unwritten.push(...requests)
      write(now)
    } else {
      for (const request of requests) answer(request, now)
    }
  }

  const applyStep = (step: Intake.Step<Request>, now: number) => {
    intake = step.intake
    for (const delivery of step.delivered) {
      const sequence = delivery.sequence as number
      history.push(sequence)
      if (!delivery.late) position = sequence + 1
      skipped = step.intake.skipped
      settle(waiting.get(sequence) ?? [], now)
      waiting.delete(sequence)
    }
    if (step.delivered.length > 0 && !rules.durable) {
      change += 1
      schedule(now + DEBOUNCE_MILLIS, { _tag: 'Debounce', generation, change })
    }
    const due = Intake.deadline(intake)
    if (due !== undefined) schedule(due, { _tag: 'Deadline', generation })
  }

  const failed = (request: Request, now: number) => {
    if (request.attempt > MAX_RETRIES) {
      abandoned.add(request.sequence)
      return
    }
    schedule(now + RETRY_MILLIS * 2 ** (request.attempt - 1), {
      _tag: 'Send',
      sequence: request.sequence,
      attempt: request.attempt + 1,
    })
  }

  for (let steps = 0; steps < 100_000 && agenda.length > 0; steps += 1) {
    agenda.sort((a, b) => a.at - b.at || a.order - b.order)
    const { at: now, happening } = agenda.shift()!
    switch (happening._tag) {
      case 'Send': {
        if (answered.has(happening.sequence)) break
        attempts.set(happening.sequence, happening.attempt)
        const lost = happening.attempt === 1 && fateOf(happening.sequence).fate === 0
        schedule(now + fateOf(happening.sequence).delay, {
          _tag: lost ? 'Fail' : 'Arrive',
          sequence: happening.sequence,
          attempt: happening.attempt,
        })
        break
      }
      case 'Arrive': {
        const request: Request = { sequence: happening.sequence, attempt: happening.attempt }
        if (Intake.isRepeat(intake, request.sequence)) {
          const original = waiting.get(request.sequence)
          if (original !== undefined) original.push(request)
          else settle([request], now)
          break
        }
        waiting.set(request.sequence, [request])
        applyStep(Intake.receive(intake, request.sequence, request, now), now)
        break
      }
      case 'Answer': {
        const lost = happening.attempt === 1 && fateOf(happening.sequence).fate === 1
        if (lost) failed(happening, now)
        else answered.add(happening.sequence)
        break
      }
      case 'Fail':
        failed(happening, now)
        break
      case 'Deadline':
        if (happening.generation === generation) applyStep(Intake.expire(intake, now), now)
        break
      case 'Written':
        if (happening.generation !== generation) break
        snapshot = happening.snapshot
        for (const request of happening.covered) if (request.attempt > 0) answer(request, now)
        writing = undefined
        write(now)
        break
      case 'Debounce':
        if (happening.generation !== generation || happening.change !== change) break
        unwritten.push({ sequence: 0, attempt: 0 })
        write(now)
        break
      case 'Crash': {
        // Every request the failed process had not answered fails at the
        // page; the next process starts from the last snapshot.
        for (const requests of waiting.values()) for (const request of requests) failed(request, now)
        for (const request of [...unwritten, ...(writing ?? [])]) if (request.attempt > 0) failed(request, now)
        generation += 1
        intake = { ...Intake.make<Request>(snapshot.position), skipped: new Set(snapshot.skipped) }
        history = [...snapshot.history]
        position = snapshot.position
        skipped = new Set(snapshot.skipped)
        waiting = new Map()
        unwritten = []
        writing = undefined
        break
      }
    }
  }
  return { history, answered, abandoned }
}
