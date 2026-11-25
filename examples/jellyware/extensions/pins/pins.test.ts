import { assert, describe, it } from '@effect/vitest'

import { seed } from '#app/seed'

import { withIssues } from './pins.ts'

/* Joining a member's pins with the workspace's issues. */

const { issues } = seed(Date.UTC(2026, 10, 25, 12))

describe('pins', () => {
  it('keeps the order of the pins and drops issues that are gone', () => {
    const [first, second] = issues
    const pinned = withIssues(
      [
        { issue_id: second!.id, pinned_at: 2 },
        { issue_id: 'gone', pinned_at: 1 },
        { issue_id: first!.id, pinned_at: 0 },
      ],
      issues,
    )
    assert.deepStrictEqual(
      pinned.map(each => [each.issue.identifier, each.pinnedAt]),
      [
        [second!.identifier, 2],
        [first!.identifier, 0],
      ],
    )
  })
})
