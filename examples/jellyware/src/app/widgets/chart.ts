import type { Html, HtmlBuilder } from 'foldkit/html'

import * as Island from '@hyper-effect/island'

import { Chart, type ChartKind, type ChartSeries, MAX_SERIES } from './chart-contract'

/* A chart for any page of the app, extension pages included: line, area or
   bar, with a tooltip for every series at the x under the pointer (or the
   keyboard), a legend that hides and shows series, and a table view. It is
   an island: the page sends the data, the browser draws it and keeps the
   hover to itself. A click comes back as a Message when `onClick` is given.

     chart({ id: 'done-per-day', kind: 'bar', label: 'Issues done per day',
             x: ['2026-11-20', ...], series: [{ id: 'eng', label: 'Engineering', values: [3, ...] }],
             unit: 'issues', onClick: point => Message.ClickedDay({ x: point.x }) }, h) */

export type ChartPoint = Readonly<{ index: number; x: string; series: string | null }>

export type ChartConfig<Message> = Readonly<{
  /** Stable and unique on the page: the island lives as long as it does. */
  id: string
  kind: ChartKind
  /** What the chart shows, for screen readers and the table view. */
  label: string
  /** The x positions in order: labels, or dates as yyyy-mm-dd (shown as
   *  "Nov 3"). */
  x: ReadonlyArray<string>
  /** One value per x position each (null where there is none). Colours
   *  follow the order; at most eight series. */
  series: ReadonlyArray<ChartSeries>
  /** Areas and bars on top of each other instead of side by side. */
  stacked?: boolean
  /** After values: "h", "%", "issues". */
  unit?: string
  decimals?: number
  /** In pixels; the width follows the container. Default 240. */
  height?: number
  onClick?: (point: ChartPoint) => Message
  class?: string
}>

export const chart = <Message>(config: ChartConfig<Message>, h: HtmlBuilder<Message>): Html => {
  const onClick = config.onClick
  return Island.view(
    Chart,
    {
      id: config.id,
      props: {
        kind: config.kind,
        x: config.x,
        series: config.series.slice(0, MAX_SERIES),
        stacked: config.stacked ?? false,
        unit: config.unit ?? '',
        decimals: config.decimals ?? 0,
        height: config.height ?? 240,
        label: config.label,
        clickable: onClick !== undefined,
      },
      ...(onClick === undefined ? {} : { onEvent: event => onClick({ index: event.index, x: event.x, series: event.series }) }),
      class: config.class ?? 'block w-full',
    },
    h,
  )
}
