/* The geometry of a chart, pure: nice ticks, stacking, scales, which x a
   pointer is nearest, and how values and dates read. The chart island
   (chart.client.ts) draws from it; tests check it without a browser. */

export type ChartKind = 'line' | 'area' | 'bar'

export type Series = Readonly<{ id: string; label: string; values: ReadonlyArray<number | null> }>

export type Margin = Readonly<{ top: number; right: number; bottom: number; left: number }>

/** One series' value at one x, after stacking: from `base` to `top`. */
export type Segment = Readonly<{ value: number | null; base: number; top: number }>

export type Layout = Readonly<{
  width: number
  height: number
  margin: Margin
  plotWidth: number
  plotHeight: number
  yTicks: ReadonlyArray<number>
  yMin: number
  yMax: number
  /** Per visible series, per x. */
  segments: ReadonlyArray<ReadonlyArray<Segment>>
  /** The width of one x position's band (bars). */
  band: number
}>

const STEPS = [1, 2, 2.5, 5, 10]

/** About `count` round ticks from `min` to `max`, covering both. */
export const niceTicks = (min: number, max: number, count = 4): ReadonlyArray<number> => {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1]
  if (min === max) {
    if (max === 0) return [0, 1]
    return max > 0 ? niceTicks(0, max, count) : niceTicks(min, 0, count)
  }
  const raw = (max - min) / count
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = (STEPS.find(each => each * magnitude >= raw) ?? 10) * magnitude
  const first = Math.floor(min / step) * step
  const last = Math.ceil(max / step) * step
  const ticks: Array<number> = []
  for (let value = first; value <= last + step / 2; value += step) ticks.push(Number(value.toPrecision(12)))
  return ticks
}

/** Values stacked in series order (`stacked`), or each from zero. A
 *  missing value adds nothing. */
export const stack = (series: ReadonlyArray<Series>, length: number, stacked: boolean): ReadonlyArray<ReadonlyArray<Segment>> => {
  const positive = new Array<number>(length).fill(0)
  const negative = new Array<number>(length).fill(0)
  return series.map(each =>
    Array.from({ length }, (_, index): Segment => {
      const value = each.values[index] ?? null
      if (!stacked || value === null) return { value, base: 0, top: value ?? 0 }
      const totals = value >= 0 ? positive : negative
      const base = totals[index] ?? 0
      totals[index] = base + value
      return { value, base, top: base + value }
    }),
  )
}

/** How much room the y labels need. */
const labelWidth = (text: string) => text.length * 6.6 + 10

export const layout = (
  options: Readonly<{ kind: ChartKind; series: ReadonlyArray<Series>; length: number; stacked: boolean; width: number; height: number; format: (value: number) => string }>,
): Layout => {
  const segments = stack(options.series, options.length, options.stacked)
  const values = segments.flatMap(each => each.flatMap(segment => (segment.value === null ? [] : [segment.base, segment.top])))
  // Bars and areas start at zero; a line may float.
  const dataMin = values.length === 0 ? 0 : Math.min(...values)
  const dataMax = values.length === 0 ? 1 : Math.max(...values)
  const fromZero = options.kind !== 'line' || dataMin >= 0
  const yTicks = niceTicks(fromZero ? Math.min(0, dataMin) : dataMin, Math.max(fromZero ? 0 : dataMin, dataMax))
  const yMin = yTicks[0] ?? 0
  const yMax = yTicks.at(-1) ?? 1
  const left = Math.max(28, ...yTicks.map(tick => labelWidth(options.format(tick))))
  const margin: Margin = { top: 10, right: 12, bottom: 24, left }
  const plotWidth = Math.max(40, options.width - margin.left - margin.right)
  const plotHeight = Math.max(40, options.height - margin.top - margin.bottom)
  return {
    width: options.width,
    height: options.height,
    margin,
    plotWidth,
    plotHeight,
    yTicks,
    yMin,
    yMax,
    segments,
    band: plotWidth / Math.max(1, options.length),
  }
}

/** Where a value sits, from the top of the plot. */
export const yOf = (layout: Layout, value: number): number =>
  layout.yMax === layout.yMin ? layout.plotHeight : ((layout.yMax - value) / (layout.yMax - layout.yMin)) * layout.plotHeight

/** Where an x position sits, from the left of the plot: the middle of its
 *  band for bars, evenly from edge to edge for lines and areas. */
export const xOf = (layout: Layout, kind: ChartKind, index: number, length: number): number =>
  kind === 'bar' ? layout.band * (index + 0.5) : length <= 1 ? layout.plotWidth / 2 : (index / (length - 1)) * layout.plotWidth

/** The x position nearest to a pointer `x` pixels from the plot's left. */
export const nearestIndex = (layout: Layout, kind: ChartKind, length: number, x: number): number | null => {
  if (length === 0 || x < -layout.margin.left / 2 || x > layout.plotWidth + layout.margin.right) return null
  const raw = kind === 'bar' ? Math.floor(x / layout.band) : length <= 1 ? 0 : Math.round((x / layout.plotWidth) * (length - 1))
  return Math.min(length - 1, Math.max(0, raw))
}

/** Every how many x positions a tick label fits. */
export const tickEvery = (plotWidth: number, labels: ReadonlyArray<string>): number => {
  const widest = Math.max(1, ...labels.map(label => label.length * 6.6 + 16))
  const fits = Math.max(1, Math.floor(plotWidth / widest))
  return Math.max(1, Math.ceil(labels.length / fits))
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Whether every x is a date (yyyy-mm-dd). */
export const areDates = (xs: ReadonlyArray<string>): boolean => xs.length > 0 && xs.every(x => DATE.test(x))

/** An x as the axis shows it: "Nov 3" for a date. */
export const xLabel = (x: string, dates: boolean): string => {
  if (!dates) return x
  const [, month = '1', day = '1'] = x.split('-')
  return `${MONTHS[Number(month) - 1] ?? month} ${Number(day)}`
}

/** An x as the tooltip shows it: "Nov 3, 2026" for a date. */
export const xTitle = (x: string, dates: boolean): string => (dates ? `${xLabel(x, true)}, ${x.slice(0, 4)}` : x)

/** A value with grouping, its decimals and its unit: "1,250 h". */
export const formatValue = (value: number, decimals: number, unit: string): string => {
  const text = value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  return unit === '' ? text : unit === '%' ? `${text}%` : `${text} ${unit}`
}

/** A bar or a stacked segment with its data end rounded (4px, or less on a
 *  short bar), from `y0` (the baseline side) to `y1`. */
export const barPath = (x: number, width: number, y0: number, y1: number, rounded: boolean): string => {
  const top = Math.min(y0, y1)
  const bottom = Math.max(y0, y1)
  const height = bottom - top
  const r = rounded ? Math.min(4, width / 2, height) : 0
  if (r <= 0) return `M${x},${bottom}V${top}H${x + width}V${bottom}Z`
  // The end away from the baseline is the rounded one.
  return y1 <= y0
    ? `M${x},${bottom}V${top + r}Q${x},${top} ${x + r},${top}H${x + width - r}Q${x + width},${top} ${x + width},${top + r}V${bottom}Z`
    : `M${x},${top}V${bottom - r}Q${x},${bottom} ${x + r},${bottom}H${x + width - r}Q${x + width},${bottom} ${x + width},${bottom - r}V${top}Z`
}

/** A line through the points, broken where a value is missing. */
export const linePath = (points: ReadonlyArray<readonly [number, number] | null>): string => {
  let path = ''
  let drawing = false
  for (const point of points) {
    if (point === null) {
      drawing = false
      continue
    }
    path += `${drawing ? 'L' : 'M'}${point[0].toFixed(1)},${point[1].toFixed(1)}`
    drawing = true
  }
  return path
}

/** The area between a line and its base, in runs without missing values. */
export const areaPath = (points: ReadonlyArray<readonly [number, number, number] | null>): string => {
  const runs: Array<Array<readonly [number, number, number]>> = [[]]
  for (const point of points) {
    if (point === null) runs.push([])
    else runs.at(-1)?.push(point)
  }
  return runs
    .filter(run => run.length > 0)
    .map(run => {
      const top = run.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join('')
      const bottom = [...run].reverse().map(([x, , base]) => `L${x.toFixed(1)},${base.toFixed(1)}`).join('')
      return `${top}${bottom}Z`
    })
    .join('')
}
