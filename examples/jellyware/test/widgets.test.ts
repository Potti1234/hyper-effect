import { assert, describe, it } from '@effect/vitest'
import { Schema as S } from 'effect'
import { Story } from 'foldkit/test'

import { ChartEvent } from '@/app/widgets/chart-contract'
import * as ChartIsland from '@/app/widgets/chart.client'
import {
  areDates,
  barPath,
  formatValue,
  layout,
  linePath,
  nearestIndex,
  niceTicks,
  stack,
  tickEvery,
  xLabel,
  xOf,
  yOf,
} from '@/app/widgets/chart-geometry'
import { fitPlaces } from '@/app/widgets/map-contract'

/* The widgets: the chart's geometry and what its island does with the
   pointer, the keyboard and clicks; where the map looks first. */

describe('chart geometry', () => {
  it('picks round ticks that cover the data', () => {
    assert.deepStrictEqual(niceTicks(0, 6), [0, 2, 4, 6])
    assert.deepStrictEqual(niceTicks(0, 7), [0, 2, 4, 6, 8])
    assert.deepStrictEqual(niceTicks(0, 0.9), [0, 0.25, 0.5, 0.75, 1])
    assert.deepStrictEqual(niceTicks(-3, 5), [-4, -2, 0, 2, 4, 6])
    assert.deepStrictEqual(niceTicks(0, 0), [0, 1])
    assert.deepStrictEqual(niceTicks(1200, 1200), [0, 500, 1000, 1500])
    // Counts: whole numbers only.
    assert.deepStrictEqual(niceTicks(0, 9, 4, true), [0, 5, 10])
    assert.deepStrictEqual(niceTicks(0, 3, 4, true), [0, 1, 2, 3])
  })

  it('stacks positive and negative values apart, and skips missing ones', () => {
    const series = [
      { id: 'a', label: 'A', values: [1, -2, null] },
      { id: 'b', label: 'B', values: [3, -1, 4] },
    ]
    assert.deepStrictEqual(stack(series, 3, true)[1], [
      { value: 3, base: 1, top: 4 },
      { value: -1, base: -2, top: -3 },
      { value: 4, base: 0, top: 4 },
    ])
    assert.deepStrictEqual(stack(series, 3, false)[1]?.[0], { value: 3, base: 0, top: 3 })
  })

  it('places x positions and finds the nearest to the pointer', () => {
    const series = [{ id: 'a', label: 'A', values: [1, 2, 3, 4, 5] }]
    const line = layout({ kind: 'line', series, length: 5, stacked: false, width: 440, height: 200, format: String })
    assert.strictEqual(xOf(line, 'line', 0, 5), 0)
    assert.strictEqual(xOf(line, 'line', 4, 5), line.plotWidth)
    assert.strictEqual(nearestIndex(line, 'line', 5, line.plotWidth * 0.6), 2)
    assert.strictEqual(nearestIndex(line, 'line', 5, line.plotWidth * 0.65), 3)
    assert.isNull(nearestIndex(line, 'line', 5, line.plotWidth + 100))
    const bars = layout({ kind: 'bar', series, length: 5, stacked: false, width: 440, height: 200, format: String })
    assert.strictEqual(xOf(bars, 'bar', 0, 5), bars.band / 2)
    assert.strictEqual(nearestIndex(bars, 'bar', 5, bars.band * 1.9), 1)
    // Bars start at zero; the top tick is above the highest value.
    assert.strictEqual(bars.yMin, 0)
    assert.isAtLeast(bars.yMax, 5)
    assert.strictEqual(yOf(bars, 0), bars.plotHeight)
  })

  it('thins tick labels to fit, and reads dates and values', () => {
    const labels = Array.from({ length: 30 }, (_, at) => `Nov ${at + 1}`)
    assert.strictEqual(tickEvery(2000, labels), 1)
    assert.strictEqual(tickEvery(1000, labels), 2)
    assert.isAbove(tickEvery(300, labels), 3)
    assert.isTrue(areDates(['2026-11-03', '2026-11-04']))
    assert.isFalse(areDates(['2026-11-03', 'Week 2']))
    assert.strictEqual(xLabel('2026-11-03', true), 'Nov 3')
    assert.strictEqual(formatValue(1250, 0, 'h'), '1,250 h')
    assert.strictEqual(formatValue(12.5, 1, '%'), '12.5%')
  })

  it('draws lines with gaps and bars with a rounded data end', () => {
    assert.strictEqual(linePath([[0, 10], [5, 20], null, [15, 5]]), 'M0.0,10.0L5.0,20.0M15.0,5.0')
    assert.match(barPath(0, 10, 100, 40, true), /^M0,100V44Q0,40 4,40H6Q10,40 10,44V100Z$/)
    assert.strictEqual(barPath(0, 10, 100, 40, false), 'M0,100V40H10V100Z')
  })
})

describe('chart island (Story)', () => {
  const props = {
    kind: 'bar' as const,
    x: ['2026-11-01', '2026-11-02', '2026-11-03'],
    series: [
      { id: 'eng', label: 'Engineering', values: [1, 2, 3] },
      { id: 'des', label: 'Design', values: [0, 1, null] },
    ],
    stacked: true,
    unit: 'issues',
    decimals: 0,
    height: 200,
    label: 'Issues done',
    clickable: true,
  }
  const model = ChartIsland.init(props).model

  it('follows the pointer and the keys, and reports a click on a bar', () => {
    const geometry = layout({ kind: 'bar', series: props.series, length: 3, stacked: true, width: 640, height: 200, format: String })
    const third = geometry.margin.left + geometry.band * 2.5
    Story.story(
      ChartIsland.update,
      Story.given(model),
      Story.message(ChartIsland.Message.MovedPointer({ x: third, y: 100 })),
      Story.model(next => assert.strictEqual(next.active, 2)),
      Story.message(ChartIsland.Message.PressedKey({ key: 'ArrowLeft' })),
      Story.model(next => assert.strictEqual(next.active, 1)),
      Story.message(ChartIsland.Message.PressedKey({ key: 'Escape' })),
      Story.model(next => assert.isNull(next.active)),
      // The Engineering bar of the third day, near the baseline.
      Story.message(ChartIsland.Message.ClickedPlot({ x: third, y: geometry.margin.top + geometry.plotHeight - 4 })),
      Story.Command.expectExact(
        ChartIsland.Emit({ event: ChartEvent.members[0].make({ index: 2, x: '2026-11-03', series: 'eng' }) }),
      ),
      Story.Command.resolve(ChartIsland.Emit, ChartIsland.Message.CompletedEmit()),
      // Hiding a series keeps its colour slot for the others; the last one stays.
      Story.message(ChartIsland.Message.ClickedLegend({ id: 'des' })),
      Story.message(ChartIsland.Message.ClickedLegend({ id: 'eng' })),
      Story.model(next => assert.deepStrictEqual(next.hidden, ['des'])),
    )
  })

  it('reports nothing when the page asked for no clicks', () => {
    Story.story(
      ChartIsland.update,
      Story.given(ChartIsland.init({ ...props, clickable: false }).model),
      Story.message(ChartIsland.Message.ClickedPlot({ x: 300, y: 150 })),
      Story.Command.expectNone(),
      Story.model(next => assert.isNotNull(next.active)),
    )
  })
})

describe('chart island events', () => {
  it('decodes what the island emits', () => {
    const decoded = S.decodeUnknownSync(ChartEvent)({ _tag: 'ClickedPoint', index: 2, x: '2026-11-03', series: 'eng' })
    assert.strictEqual(decoded.series, 'eng')
  })
})

describe('map', () => {
  it('fits every place, and looks close at one', () => {
    const one = fitPlaces([{ longitude: 11.58, latitude: 48.14 }], 720, 360)
    assert.deepStrictEqual(one.zoom, 13)
    const europe = fitPlaces(
      [
        { longitude: -0.13, latitude: 51.51 },
        { longitude: 24.94, latitude: 60.17 },
      ],
      720,
      360,
    )
    assert.closeTo(europe.center[0], 12.4, 0.1)
    assert.isAbove(europe.zoom, 2)
    assert.isBelow(europe.zoom, 6)
    assert.deepStrictEqual(fitPlaces([], 720, 360).zoom, 3)
  })
})
