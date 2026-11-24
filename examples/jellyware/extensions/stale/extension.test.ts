import { assert, describe, it } from '@effect/vitest'

import { seed } from '#app/seed'

import { staleBadges } from './extension.ts'

/* Which issues get the badge, and what it says. */

const DAY = 24 * 60 * 60 * 1000
const now = Date.UTC(2026, 10, 24, 12)
const { issues } = seed(now)

describe('stale: badges', () => {
  it('marks open issues unchanged for the given days, with their age', () => {
    const badges = staleBadges(issues, now, 10)
    assert.isAbove(badges.length, 0)
    for (const badge of badges) {
      const issue = issues.find(candidate => candidate.id === badge.target)!
      assert.notInclude(['done', 'canceled'], issue.status)
      assert.isAtLeast(now - issue.updatedAt, 10 * DAY)
      assert.strictEqual(badge.label, `Stale ${Math.floor((now - issue.updatedAt) / DAY)}d`)
      assert.strictEqual(badge.tone, 'warning')
    }
  })

  it('marks none when nothing is that old', () => {
    assert.deepStrictEqual(staleBadges(issues, now, 365), [])
  })
})
