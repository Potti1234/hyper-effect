import { assert, describe, it } from '@effect/vitest'

import { type FailureOutcome, FailureScenario, type Rules, simulateFailures } from './protocol-simulation'

/* Phase A2: the intake properties extended to process failures. The page
   retries, processes fail and take over from snapshots; see
   protocol-simulation.ts for what is modelled. */

// THE SPECIFICATION

/** No event is applied twice, across any number of failures. */
export const neverTwice = (outcome: FailureOutcome): boolean =>
  new Set(outcome.history).size === outcome.history.length

/** Every event the page was answered for is applied. */
export const answeredSurvive = (outcome: FailureOutcome): boolean =>
  [...outcome.answered].every(sequence => outcome.history.includes(sequence))

/** Every event is answered in the end: retries outlast the failures. */
export const everythingAnswered = (outcome: FailureOutcome, events: number): boolean =>
  outcome.answered.size === events && outcome.abandoned.size === 0

const current: Rules = { durable: true, keepSkipped: true }

/** Failures hit narrow windows (between a skip and a late retry), so many
 *  runs. */
const RUNS = { arbitrary: { runs: 2000 } }

const describeOutcome = (outcome: FailureOutcome) =>
  `history=${JSON.stringify(outcome.history)} answered=${JSON.stringify([...outcome.answered])}`

describe('delivery across failures (properties)', () => {
  it.prop('applies no event twice', [FailureScenario], ([scenario]) => {
    const outcome = simulateFailures(scenario, current)
    assert.isTrue(neverTwice(outcome), describeOutcome(outcome))
  }, RUNS)

  it.prop('loses no answered event', [FailureScenario], ([scenario]) => {
    const outcome = simulateFailures(scenario, current)
    assert.isTrue(answeredSurvive(outcome), describeOutcome(outcome))
  }, RUNS)

  it.prop('answers every event in the end', [FailureScenario], ([scenario]) => {
    const outcome = simulateFailures(scenario, current)
    assert.isTrue(everythingAnswered(outcome, scenario.events.length), describeOutcome(outcome))
  }, RUNS)
})

describe('delivery across failures (counterexamples to the earlier rules)', () => {
  it('answering before the snapshot loses an answered event', () => {
    // Event 1 is applied and answered; the process fails before the quiet
    // second is over, so the snapshot never held it.
    const scenario: FailureScenario = {
      events: [{ gap: 0, delay: 10, fate: 5 }],
      failures: [500],
      writeMillis: 0,
    }
    const outcome = simulateFailures(scenario, { durable: false, keepSkipped: true })
    assert.isFalse(answeredSurvive(outcome), describeOutcome(outcome))
    assert.isTrue(answeredSurvive(simulateFailures(scenario, current)))
  })

  it('a snapshot without the skipped numbers answers a late retry without applying it', () => {
    // Event 1's first request fails; event 2 waits behind it, the gap is
    // skipped and 2 applied. The process fails, and the retry of 1 reaches
    // the next one, which only knows the position (3): a repeat, it says.
    const scenario: FailureScenario = {
      events: [
        { gap: 0, delay: 600, fate: 0 },
        { gap: 0, delay: 0, fate: 5 },
      ],
      failures: [1800],
      writeMillis: 10,
    }
    const outcome = simulateFailures(scenario, { durable: true, keepSkipped: false })
    assert.isFalse(answeredSurvive(outcome), describeOutcome(outcome))
    const fixed = simulateFailures(scenario, current)
    assert.isTrue(answeredSurvive(fixed), describeOutcome(fixed))
    assert.deepStrictEqual(fixed.history, [2, 1])
  })
})
