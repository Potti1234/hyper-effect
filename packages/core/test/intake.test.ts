import { assert, describe, it } from '@effect/vitest'

import * as Intake from '../src/intake'

import { Fate, GoodNetwork, type IntakeImplementation, type Outcome, Scenario, simulate } from './intake-simulation'

/* Experiment 5: the ordered intake against its specification, over generated
   networks that delay, reorder, lose and repeat events. */

const implementation: IntakeImplementation<Intake.Intake<number>> = {
  make: next => Intake.make<number>(next),
  receive: Intake.receive,
  expire: Intake.expire,
  deadline: Intake.deadline,
  parkedCount: intake => intake.parked.size,
}

// THE SPECIFICATION

/** Every event that arrived is applied exactly once: none lost, none twice. */
export const appliesEachArrivalOnce = (outcome: Outcome): boolean => {
  const applied = outcome.deliveries.map(delivery => delivery.sequence).sort((a, b) => a - b)
  const arrived = [...outcome.arrivals.keys()].sort((a, b) => a - b)
  return applied.length === arrived.length && applied.every((sequence, index) => sequence === arrived[index])
}

/** Events applied in order are applied in ascending sequence order. */
export const appliesInOrder = (outcome: Outcome): boolean => {
  const inOrder = outcome.deliveries.filter(delivery => !delivery.late).map(delivery => delivery.sequence)
  return inOrder.every((sequence, index) => index === 0 || (inOrder[index - 1] as number) < sequence)
}

/** An event is applied out of order only after a later one went ahead of it,
 *  that is, after its gap was skipped. */
export const lateOnlyAfterASkip = (outcome: Outcome): boolean =>
  outcome.deliveries.every(
    (delivery, index) =>
      !delivery.late ||
      outcome.deliveries.slice(0, index).some(earlier => !earlier.late && earlier.sequence > delivery.sequence),
  )

/** Nothing waits forever: once the network is quiet, nothing is parked. */
export const holdsNothingForever = (outcome: Outcome): boolean => outcome.parkedAtEnd === 0

/** A parked event waits at most one gap timeout per earlier event that never
 *  arrived, plus the time the earlier events took to arrive. */
export const waitsBoundedTime = (outcome: Outcome, fates: ReadonlyArray<Fate>): boolean =>
  outcome.deliveries.every(delivery => {
    if (delivery.late) return true
    const arrived = outcome.arrivals.get(delivery.sequence) ?? 0
    const earlier = fates.slice(0, delivery.sequence - 1)
    const lost = earlier.filter(fate => fate.fate === 0).length
    const lastEarlierArrival = Math.max(
      arrived,
      ...[...outcome.arrivals].filter(([sequence]) => sequence < delivery.sequence).map(([, at]) => at),
    )
    return delivery.at <= lastEarlierArrival + Intake.GAP_TIMEOUT_MILLIS * (lost + 1)
  })

const check = (name: string, holds: boolean, outcome: Outcome) =>
  assert.isTrue(holds, `${name}: ${JSON.stringify(outcome.deliveries)} parked=${outcome.parkedAtEnd}`)

describe('ordered intake (properties)', () => {
  it.prop('applies every arrived event exactly once', [Scenario], ([fates]) => {
    check('exactly once', appliesEachArrivalOnce(simulate(implementation, fates)), simulate(implementation, fates))
  })

  it.prop('applies in order, out of order only after a skipped gap', [Scenario], ([fates]) => {
    const outcome = simulate(implementation, fates)
    check('in order', appliesInOrder(outcome), outcome)
    check('late only after a skip', lateOnlyAfterASkip(outcome), outcome)
  })

  it.prop('holds nothing forever, and nothing longer than its gaps', [Scenario], ([fates]) => {
    const outcome = simulate(implementation, fates)
    check('nothing parked at the end', holdsNothingForever(outcome), outcome)
    check('bounded wait', waitsBoundedTime(outcome, fates), outcome)
  })

  it.prop('applies everything in exact order on a good network', [GoodNetwork], ([network]) => {
    const fates = network.map(({ gap, delay }) => ({ gap, delay, fate: 9, retryDelay: 0 }))
    const outcome = simulate(implementation, fates)
    assert.deepStrictEqual(
      outcome.deliveries.map(delivery => [delivery.sequence, delivery.late]),
      fates.map((_, index) => [index + 1, false]),
    )
  })
})

describe('ordered intake (cases)', () => {
  it('drops a retry of an event already applied', () => {
    const first = Intake.receive(Intake.make<string>(1), 1, 'a', 0)
    const retry = Intake.receive(first.intake, 1, 'a again', 10)
    assert.deepStrictEqual(first.delivered.map(delivery => delivery.item), ['a'])
    assert.isTrue(retry.repeated)
    assert.deepStrictEqual(retry.delivered, [])
  })

  it('applies a skipped event once when it turns up late', () => {
    const parked = Intake.receive(Intake.make<string>(1), 2, 'b', 0)
    const skipped = Intake.expire(parked.intake, Intake.GAP_TIMEOUT_MILLIS)
    assert.deepStrictEqual(skipped.skippedNow, [1])
    assert.deepStrictEqual(skipped.delivered.map(delivery => delivery.item), ['b'])
    const late = Intake.receive(skipped.intake, 1, 'a', 2000)
    assert.deepStrictEqual(late.delivered, [{ sequence: 1, item: 'a', late: true }])
    assert.isTrue(Intake.receive(late.intake, 1, 'a again', 2100).repeated)
  })

  it('arms a new deadline for a second gap behind the first', () => {
    // 1 and 3 are lost; 2 and 4 are parked behind them.
    let intake = Intake.receive(Intake.make<string>(1), 2, 'b', 0).intake
    intake = Intake.receive(intake, 4, 'd', 0).intake
    const first = Intake.expire(intake, Intake.GAP_TIMEOUT_MILLIS)
    assert.deepStrictEqual(first.delivered.map(delivery => delivery.item), ['b'])
    assert.strictEqual(Intake.deadline(first.intake), 2 * Intake.GAP_TIMEOUT_MILLIS)
    const second = Intake.expire(first.intake, 2 * Intake.GAP_TIMEOUT_MILLIS)
    assert.deepStrictEqual(second.delivered.map(delivery => delivery.item), ['d'])
    assert.isUndefined(Intake.deadline(second.intake))
  })

  it('learns its position from the first event, and still takes earlier ones in flight once', () => {
    const learned = Intake.receive(Intake.make<string>(), 40, 'x', 0)
    assert.deepStrictEqual(learned.delivered.map(delivery => delivery.item), ['x'])
    const inFlight = Intake.receive(learned.intake, 39, 'w', 5)
    assert.deepStrictEqual(inFlight.delivered, [{ sequence: 39, item: 'w', late: true }])
    assert.isTrue(Intake.receive(inFlight.intake, 39, 'w', 6).repeated)
  })

  it('skips at once when too many events are parked', () => {
    let intake = Intake.make<number>(1)
    let delivered = 0
    for (let sequence = 2; sequence <= 70; sequence += 1) {
      const step = Intake.receive(intake, sequence, sequence, 0)
      delivered += step.delivered.length
      intake = step.intake
    }
    assert.isAbove(delivered, 0)
    assert.isAtMost(intake.parked.size, 64)
  })

  it('remembers a bounded number of skipped events, even for a huge jump', () => {
    const jump = Intake.receive(Intake.make<string>(1), 1_000_000_000, 'far', 0)
    const skipped = Intake.expire(jump.intake, Intake.GAP_TIMEOUT_MILLIS)
    assert.deepStrictEqual(skipped.delivered.map(delivery => delivery.item), ['far'])
    assert.isAtMost(skipped.intake.skipped.size, 256)
  })
})
