import { assert, describe, it } from '@effect/vitest'
import { Scene, Story } from 'foldkit/test'

import { SEED_MEMBERS, seed } from '#app/seed'

import * as Standup from './page.ts'

/* The Stand-up page: its update with Story, its view with Scene. Run by
   `npm test` and by the checks of every run that changes this extension. */

const { issues } = seed(Date.UTC(2026, 10, 24, 12))
const ada = SEED_MEMBERS[0]!
const inFlight = issues.filter(issue => issue.status === 'in_progress' || issue.status === 'in_review')
const inReview = inFlight.find(issue => issue.status === 'in_review')!

const model = (): Standup.Model =>
  Standup.init({ shell: { me: ada, counts: { my: 0, ENG: 0, DES: 0 }, nav: [] }, members: SEED_MEMBERS, issues: inFlight }).model

describe('standup: update (Story)', () => {
  it('shows issues in review until the toggle hides them', () => {
    Story.story(
      Standup.update,
      Story.given(model()),
      Story.model(next => assert.isTrue(next.showReview)),
      Story.message(Standup.Message.ClickedToggleReview()),
      Story.model(next => assert.isFalse(next.showReview)),
    )
  })
})

describe('standup: view (Scene)', () => {
  it('lists each member’s issues and hides those in review on a click', () => {
    Scene.scene(
      Standup.program,
      Scene.given(model()),
      Scene.expect(Scene.selector(`a[href="/issue/${inReview.identifier}"]`)).toExist(),
      Scene.click(Scene.selector('#standup-show-review')),
      Scene.expect(Scene.selector(`a[href="/issue/${inReview.identifier}"]`)).toBeAbsent(),
    )
  })
})
