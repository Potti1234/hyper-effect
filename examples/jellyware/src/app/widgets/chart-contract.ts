import { Schema as S } from 'effect'

import * as Island from '@hyper-effect/island/contract'

/* The chart island's contract: what a page sends it (props) and what it
   reports (events). Shared by the server (`chart` in chart.ts) and the
   browser (chart.client.ts). */

export const ChartSeries = S.Struct({
  id: S.String,
  label: S.String,
  /** One value per x position; null where there is none. */
  values: S.Array(S.NullOr(S.Number)),
})
export type ChartSeries = typeof ChartSeries.Type

export const ChartKind = S.Literals(['line', 'area', 'bar'])
export type ChartKind = typeof ChartKind.Type

/** Server → island. */
export const ChartProps = S.Struct({
  kind: ChartKind,
  /** The x positions in order: labels, or dates as yyyy-mm-dd. */
  x: S.Array(S.String),
  /** At most eight; each keeps its colour by its place in this list. */
  series: S.Array(ChartSeries),
  /** Series stacked on each other (areas, bars) instead of side by side. */
  stacked: S.Boolean,
  /** Shown after values: "h", "%", "issues". */
  unit: S.String,
  decimals: S.Number,
  height: S.Number,
  /** Names the chart for screen readers and the table view. */
  label: S.String,
  /** Whether a click on an x position (or a bar) is reported. */
  clickable: S.Boolean,
})
export type ChartProps = typeof ChartProps.Type

/** Island → server. */
export const ChartEvent = S.Union([
  S.TaggedStruct('ClickedPoint', {
    index: S.Number,
    x: S.String,
    /** The bar's series; null for a click on a line or area chart. */
    series: S.NullOr(S.String),
  }),
])
export type ChartEvent = typeof ChartEvent.Type

export const Chart = Island.define({ tag: 'app-chart', Props: ChartProps, Event: ChartEvent })

/** The most series a chart shows; more must be folded into "Other". */
export const MAX_SERIES = 8
