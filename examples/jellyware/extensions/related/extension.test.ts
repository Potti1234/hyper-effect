import { assert, describe, it } from '@effect/vitest'

import { seed } from '#app/seed'

import { cardFor } from './extension.ts'

/* The card: open issues sharing a label, at most `max`, and "Mark urgent"
   only when it applies. */

const { issues } = seed(Date.UTC(2026, 10, 24, 12))
const options = { title: 'Related', max: 3, urgentAction: true }

describe('related: card', () => {
  const issue = issues.find(candidate => candidate.priority !== 1 && candidate.labelIds.length > 0)!

  it('lists open issues that share a label, linked, up to max', () => {
    const card = cardFor(issue.id, issues, options)
    assert.strictEqual(card.title, 'Related')
    assert.isAtMost(card.items.length, 3)
    for (const item of card.items) {
      const other = issues.find(candidate => candidate.identifier === item.detail)!
      assert.isTrue(other.labelIds.some(id => issue.labelIds.includes(id)))
      assert.strictEqual(item.href, `/issue/${other.identifier}`)
    }
  })

  it('offers Mark urgent unless the issue is urgent or the setting is off', () => {
    assert.deepStrictEqual(cardFor(issue.id, issues, options).actions.map(action => action.command), ['related.mark-urgent'])
    assert.deepStrictEqual(cardFor(issue.id, issues, { ...options, urgentAction: false }).actions, [])
    const urgent = issues.find(candidate => candidate.priority === 1)!
    assert.deepStrictEqual(cardFor(urgent.id, issues, options).actions, [])
  })
})
