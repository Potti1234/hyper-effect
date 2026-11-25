import { assert, describe, it } from '@effect/vitest'
import { Story } from 'foldkit/test'

import { SEED_MEMBERS, seed } from '#app/seed'

import { Message, Move, init, update } from './page.ts'
import { citiesOf, openIn } from './places.ts'

/* The cities from the places table, and what a browser may post. */

const { issues } = seed(Date.UTC(2026, 10, 25, 12))
const rows = [
  { member_id: 'ada', city: 'London', longitude: -0.1, latitude: 51.5 },
  { member_id: 'alan', city: 'London', longitude: -0.2, latitude: 51.6 },
  { member_id: 'grace', city: 'New York', longitude: -74, latitude: 40.7 },
  { member_id: 'nobody', city: 'Paris', longitude: 2.3, latitude: 48.9 },
]

describe('team map', () => {
  it('groups members by city, with their open issues', () => {
    const cities = citiesOf(rows, SEED_MEMBERS, issues)
    assert.deepStrictEqual(cities.map(city => [city.name, city.people.map(person => person.id)]), [
      ['London', ['ada', 'alan']],
      ['New York', ['grace']],
    ])
    const london = cities[0]!
    assert.closeTo(london.longitude, -0.15, 1e-9)
    const adaOpen = issues.filter(issue => issue.assigneeId === 'ada' && issue.status !== 'done' && issue.status !== 'canceled').length
    assert.strictEqual(london.people[0]!.open.length, adaOpen)
    assert.strictEqual(openIn(london), london.people.reduce((sum, person) => sum + person.open.length, 0))
  })

  it('selects only cities it shows, and moves the marker only after asking', () => {
    const shell = { me: SEED_MEMBERS[0]!, counts: { my: 0, ENG: 0, DES: 0 }, nav: [] }
    const model = init({ shell, cities: citiesOf(rows, SEED_MEMBERS, issues) }).model
    Story.story(
      update,
      Story.given(model),
      Story.message(Message.ClickedCity({ name: 'Atlantis' })),
      Story.model(next => assert.isNull(next.selected)),
      Story.message(Message.ClickedCity({ name: 'London' })),
      Story.model(next => assert.strictEqual(next.selected, 'London')),
      // A picked location before "Move my marker" is ignored.
      Story.message(Message.PickedLocation({ longitude: 13.4, latitude: 52.5 })),
      Story.Command.expectNone(),
      Story.message(Message.ClickedMove()),
      Story.message(Message.PickedLocation({ longitude: 999, latitude: 52.5 })),
      Story.Command.expectNone(),
      Story.message(Message.PickedLocation({ longitude: 13.4, latitude: 52.5 })),
      Story.Command.expectExact(Move({ memberId: 'ada', longitude: 13.4, latitude: 52.5 })),
      Story.model(next => assert.isFalse(next.moving)),
      Story.Command.resolve(Move, Message.FinishedMove({ message: 'Moved your marker.' })),
    )
  })
})
