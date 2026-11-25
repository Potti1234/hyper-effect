import { Effect, Match as M, Option, Queue, Schema as S, Stream } from 'effect'
import { Command, Mount, Port, Runtime, Subscription, type Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import { cn } from '@/lib/utils'

import { ChartEvent, ChartProps } from './chart-contract'
import {
  type Layout,
  areDates,
  areaPath,
  barPath,
  formatValue,
  layout,
  linePath,
  nearestIndex,
  tickEvery,
  xLabel,
  xOf,
  xTitle,
  yOf,
} from './chart-geometry'

/* The chart island: a Foldkit program in the browser. The page sends the
   data as props; everything a reader does to look at it (the x under the
   pointer or the arrow keys, the tooltip, hiding a series, the table view)
   stays here. A click goes out as an event only when the page asked for
   clicks.

   Colours come from --series-1 … --series-8 (styles.css), in the order the
   series were given, so a hidden series never repaints the others. */

// MODEL

export const Model = S.Struct({
  props: ChartProps,
  /** The plot's width in pixels, measured. */
  width: S.Number,
  /** The x position shown in the tooltip. */
  active: S.NullOr(S.Number),
  /** Series the reader hid, by id. */
  hidden: S.Array(S.String),
  table: S.Boolean,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ReceivedProps: { props: ChartProps },
  MeasuredPlot: { width: S.Number },
  MovedPointer: { x: S.Number, y: S.Number },
  LeftPlot: {},
  ClickedPlot: { x: S.Number, y: S.Number },
  PressedKey: { key: S.String },
  ClickedLegend: { id: S.String },
  ClickedTable: {},
  CompletedEmit: {},
})
export type Message = typeof Message.Type

// PORT

export const ports = {
  inbound: { props: Port.inbound(ChartProps) },
  outbound: { events: Port.outbound(ChartEvent) },
}

// COMMAND

export const Emit = Command.define('EmitChartEvent', {
  args: { event: ChartEvent },
  messages: [Message.CompletedEmit],
  execute: ({ event }) => Port.emit(ports.outbound.events, event).pipe(Effect.as(Message.CompletedEmit())),
})

type PlotMessage =
  | typeof Message.MeasuredPlot.Type
  | typeof Message.MovedPointer.Type
  | typeof Message.LeftPlot.Type
  | typeof Message.ClickedPlot.Type

/** The plot's width, and the pointer over it (relative to the plot). */
const TrackPlot = Mount.defineStream('TrackChartPlot', {
  messages: [Message.MeasuredPlot, Message.MovedPointer, Message.LeftPlot, Message.ClickedPlot],
  execute: ({ element }) =>
    Stream.callback<PlotMessage>(queue =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            if (!(element instanceof HTMLElement)) return () => undefined
            const at = (event: PointerEvent | MouseEvent) => {
              const box = element.getBoundingClientRect()
              return { x: event.clientX - box.left, y: event.clientY - box.top }
            }
            const observer = new ResizeObserver(entries => {
              const width = entries[0]?.contentRect.width ?? 0
              if (width > 0) Queue.offerUnsafe(queue, Message.MeasuredPlot({ width: Math.round(width) }))
            })
            observer.observe(element)
            const move = (event: PointerEvent) => Queue.offerUnsafe(queue, Message.MovedPointer(at(event)))
            const leave = () => Queue.offerUnsafe(queue, Message.LeftPlot())
            const click = (event: MouseEvent) => Queue.offerUnsafe(queue, Message.ClickedPlot(at(event)))
            element.addEventListener('pointermove', move)
            element.addEventListener('pointerleave', leave)
            element.addEventListener('click', click)
            return () => {
              observer.disconnect()
              element.removeEventListener('pointermove', move)
              element.removeEventListener('pointerleave', leave)
              element.removeEventListener('click', click)
            }
          }),
          stop => Effect.sync(stop),
        )
        return yield* Effect.never
      }),
    ),
})

// INIT

export const init = (props: ChartProps): Update.Return<Model, Message> => ({
  model: { props, width: 640, active: null, hidden: [], table: false },
})

// DERIVED

/** The series shown, each with its colour slot (its place in the props). */
const shown = (model: Model) =>
  model.props.series.flatMap((series, slot) => (model.hidden.includes(series.id) ? [] : [{ series, slot }]))

const format = (model: Model) => (value: number) => formatValue(value, model.props.decimals, model.props.unit)

const layoutOf = (model: Model): Layout =>
  layout({
    kind: model.props.kind,
    series: shown(model).map(each => each.series),
    length: model.props.x.length,
    stacked: model.props.stacked,
    width: model.width,
    height: model.props.height,
    format: value => formatValue(value, model.props.decimals, ''),
    integer: model.props.decimals === 0,
  })

/** The series of the bar under a point of the plot; null outside bars. */
const barAt = (model: Model, geometry: Layout, index: number, x: number, y: number): string | null => {
  const visible = shown(model)
  if (model.props.kind !== 'bar' || visible.length === 0) return null
  if (!model.props.stacked) {
    const inner = geometry.band * 0.72
    const start = geometry.band * index + (geometry.band - inner) / 2
    const at = Math.floor(((x - start) / inner) * visible.length)
    return visible[at]?.series.id ?? null
  }
  const hit = visible.findIndex((_, at) => {
    const segment = geometry.segments[at]?.[index]
    if (segment === undefined || segment.value === null) return false
    const a = yOf(geometry, segment.base)
    const b = yOf(geometry, segment.top)
    return y >= Math.min(a, b) - 2 && y <= Math.max(a, b) + 2
  })
  return visible[hit]?.series.id ?? null
}

// UPDATE

type UpdateReturn = Update.Return<Model, Message>

const clampIndex = (model: Model, index: number) => Math.min(model.props.x.length - 1, Math.max(0, index))

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ReceivedProps: ({ props }) => ({
        model: {
          ...model,
          props,
          active: model.active !== null && model.active < props.x.length ? model.active : null,
          hidden: model.hidden.filter(id => props.series.some(series => series.id === id)),
        },
      }),
      MeasuredPlot: ({ width }) => ({ model: width === model.width ? model : { ...model, width } }),
      MovedPointer: ({ x }) => {
        const geometry = layoutOf(model)
        const active = nearestIndex(geometry, model.props.kind, model.props.x.length, x - geometry.margin.left)
        return { model: active === model.active ? model : { ...model, active } }
      },
      LeftPlot: () => ({ model: model.active === null ? model : { ...model, active: null } }),
      // A tap shows the tooltip; with clicks asked for, it is reported too.
      ClickedPlot: ({ x, y }) => {
        const geometry = layoutOf(model)
        const plotX = x - geometry.margin.left
        const index = nearestIndex(geometry, model.props.kind, model.props.x.length, plotX)
        if (index === null) return { model }
        const next = { ...model, active: index }
        if (!model.props.clickable) return { model: next }
        const series = barAt(model, geometry, index, plotX, y - geometry.margin.top)
        if (model.props.kind === 'bar' && series === null) return { model: next }
        return {
          model: next,
          commands: [Emit({ event: ChartEvent.members[0].make({ index, x: model.props.x[index] ?? '', series }) })],
        }
      },
      PressedKey: ({ key }) => {
        const last = model.props.x.length - 1
        if (last < 0) return { model }
        const from = model.active ?? -1
        const active =
          key === 'ArrowRight'
            ? clampIndex(model, from + 1)
            : key === 'ArrowLeft'
              ? clampIndex(model, from === -1 ? last : from - 1)
              : key === 'Home'
                ? 0
                : key === 'End'
                  ? last
                  : key === 'Escape'
                    ? null
                    : model.active
        if (key === 'Enter' && model.active !== null && model.props.clickable && model.props.kind !== 'bar') {
          return {
            model,
            commands: [Emit({ event: ChartEvent.members[0].make({ index: model.active, x: model.props.x[model.active] ?? '', series: null }) })],
          }
        }
        return { model: { ...model, active } }
      },
      // The last shown series stays.
      ClickedLegend: ({ id }) =>
        model.hidden.includes(id)
          ? { model: { ...model, hidden: model.hidden.filter(other => other !== id) } }
          : shown(model).length <= 1
            ? { model }
            : { model: { ...model, hidden: [...model.hidden, id] } },
      ClickedTable: () => ({ model: { ...model, table: !model.table, active: null } }),
      CompletedEmit: () => ({ model }),
    }),
  )

// SUBSCRIPTION

export const subscriptions = Subscription.make<Model, Message>()(_entry => ({
  props: Port.subscriptionEntry(ports.inbound.props, props => Message.ReceivedProps({ props })),
}))

// VIEW

const color = (slot: number) => `var(--series-${(slot % 8) + 1})`

/** A short stroke in a series' colour: the key of a line (and of every
 *  tooltip row). */
const lineKey = (slot: number, h: HtmlBuilder<Message>): Html =>
  h.span([h.Class('inline-block h-0.5 w-3 shrink-0 rounded-full'), h.Style({ background: color(slot) })], [])

/** A small square: the key of a bar or an area in the legend. */
const boxKey = (slot: number, h: HtmlBuilder<Message>): Html =>
  h.span([h.Class('inline-block size-2.5 shrink-0 rounded-[2px]'), h.Style({ background: color(slot) })], [])

const legend = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  model.props.series.length < 2
    ? []
    : model.props.series.map((series, slot) => {
        const off = model.hidden.includes(series.id)
        return h.button(
          [
            h.Type('button'),
            h.DataAttribute('series', series.id),
            h.AriaPressed(String(!off)),
            h.Title(off ? `Show ${series.label}` : `Hide ${series.label}`),
            h.OnClick(Message.ClickedLegend({ id: series.id })),
            h.Class(cn('inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground', off && 'opacity-45 line-through')),
          ],
          [model.props.kind === 'line' ? lineKey(slot, h) : boxKey(slot, h), series.label],
        )
      })

const header = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1')],
    [
      ...legend(model, h),
      h.span([h.Class('flex-1')], []),
      h.button(
        [
          h.Type('button'),
          h.DataAttribute('chart-table', ''),
          h.AriaPressed(String(model.table)),
          h.OnClick(Message.ClickedTable()),
          h.Class('rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground'),
        ],
        [model.table ? 'Chart' : 'Table'],
      ),
    ],
  )

const tableView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const dates = areDates(model.props.x)
  const value = (number: number | null) => (number === null ? '–' : format(model)(number))
  return h.div(
    [h.Class('overflow-auto rounded-md border'), h.Style({ maxHeight: `${model.props.height}px` })],
    [
      h.table(
        [h.Class('w-full text-[12px] tabular-nums')],
        [
          h.caption([h.Class('sr-only')], [model.props.label]),
          h.thead(
            [h.Class('sticky top-0 bg-muted text-muted-foreground')],
            [
              h.tr(
                [],
                [
                  h.th([h.Scope('col'), h.Class('px-2 py-1 text-left font-medium')], ['']),
                  ...model.props.series.map(series => h.th([h.Scope('col'), h.Class('px-2 py-1 text-right font-medium')], [series.label])),
                ],
              ),
            ],
          ),
          h.tbody(
            [],
            model.props.x.map((x, index) =>
              h.tr(
                [h.Class('border-t')],
                [
                  h.th([h.Scope('row'), h.Class('px-2 py-1 text-left font-normal text-muted-foreground')], [xTitle(x, dates)]),
                  ...model.props.series.map(series => h.td([h.Class('px-2 py-1 text-right')], [value(series.values[index] ?? null)])),
                ],
              ),
            ),
          ),
        ],
      ),
    ],
  )
}

const axes = (model: Model, geometry: Layout, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const dates = areDates(model.props.x)
  const labels = model.props.x.map(x => xLabel(x, dates))
  const every = tickEvery(geometry.plotWidth, labels)
  const length = model.props.x.length
  return [
    ...geometry.yTicks.map(tick =>
      h.g(
        [],
        [
          h.line([
            h.X1('0'),
            h.X2(String(geometry.plotWidth)),
            h.Y1(String(yOf(geometry, tick))),
            h.Y2(String(yOf(geometry, tick))),
            h.Class(tick === 0 ? 'stroke-muted-foreground/50' : 'stroke-border'),
            h.StrokeWidth('1'),
          ]),
          h.text(
            [h.X('-8'), h.Y(String(yOf(geometry, tick))), h.TextAnchor('end'), h.DominantBaseline('middle'), h.Class('fill-muted-foreground text-[11px] tabular-nums')],
            [formatValue(tick, model.props.decimals, '')],
          ),
        ],
      ),
    ),
    ...labels.flatMap((label, index) =>
      index % every !== 0
        ? []
        : [
            h.text(
              [
                h.X(String(xOf(geometry, model.props.kind, index, length))),
                h.Y(String(geometry.plotHeight + 16)),
                h.TextAnchor(model.props.kind !== 'bar' && index === 0 ? 'start' : model.props.kind !== 'bar' && index === length - 1 ? 'end' : 'middle'),
                h.Class('fill-muted-foreground text-[11px]'),
              ],
              [label],
            ),
          ],
    ),
  ]
}

const marks = (model: Model, geometry: Layout, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const visible = shown(model)
  const length = model.props.x.length
  const zero = yOf(geometry, Math.max(geometry.yMin, Math.min(0, geometry.yMax)))
  if (model.props.kind === 'bar') {
    const inner = geometry.band * 0.72
    const groups = model.props.stacked ? 1 : Math.max(1, visible.length)
    const width = Math.max(1, (inner - (groups - 1) * 2) / groups)
    // The topmost segment of a stack is the one with the rounded end.
    const topmost = (index: number) => visible.reduce((last, _, at) => ((geometry.segments[at]?.[index]?.value ?? 0) === 0 ? last : at), -1)
    return visible.flatMap(({ series, slot }, at) =>
      Array.from({ length }, (_, index) => {
        const segment = geometry.segments[at]?.[index]
        if (segment === undefined || segment.value === null || segment.value === 0) return []
        const left = geometry.band * index + (geometry.band - inner) / 2 + (model.props.stacked ? 0 : at * (width + 2))
        const y0 = yOf(geometry, segment.base)
        const y1 = yOf(geometry, segment.top)
        // A 2px gap between stacked segments.
        const gap = model.props.stacked && segment.base !== 0 ? (y1 < y0 ? -2 : 2) : 0
        const dimmed = model.active !== null && model.active !== index
        return [
          h.path([
            h.D(barPath(left, width, y0 + gap, y1, !model.props.stacked || topmost(index) === at)),
            h.DataAttribute('bar', `${series.id}:${index}`),
            h.Style({ fill: color(slot), opacity: dimmed ? '0.55' : '1', transition: 'opacity 120ms' }),
          ]),
        ]
      }).flat(),
    )
  }
  return visible.flatMap(({ series, slot }, at) => {
    const segments = geometry.segments[at] ?? []
    const points = segments.map((segment, index) =>
      segment.value === null ? null : ([xOf(geometry, model.props.kind, index, length), yOf(geometry, segment.top)] as const),
    )
    const area =
      model.props.kind === 'area'
        ? [
            h.path([
              h.D(
                areaPath(
                  segments.map((segment, index) =>
                    segment.value === null
                      ? null
                      : ([xOf(geometry, 'area', index, length), yOf(geometry, segment.top), model.props.stacked ? yOf(geometry, segment.base) : zero] as const),
                  ),
                ),
              ),
              h.Style({ fill: color(slot), opacity: model.props.stacked ? '0.85' : '0.16' }),
            ]),
          ]
        : []
    // A lone point between gaps has no line: a dot shows it.
    const lone = points.flatMap((point, index) =>
      point !== null && points[index - 1] == null && points[index + 1] == null
        ? [h.circle([h.Cx(String(point[0])), h.Cy(String(point[1])), h.R('2.5'), h.Style({ fill: color(slot) })])]
        : [],
    )
    return [
      ...area,
      h.path([
        h.D(linePath(points)),
        h.DataAttribute('line', series.id),
        h.Fill('none'),
        h.StrokeWidth('2'),
        h.StrokeLinejoin('round'),
        h.StrokeLinecap('round'),
        h.Style({ stroke: model.props.kind === 'area' && model.props.stacked ? 'var(--background)' : color(slot) }),
      ]),
      ...lone,
    ]
  })
}

/** The hover layer: a band behind bars, or a hairline with a dot on each
 *  line at the active x. */
const hover = (model: Model, geometry: Layout, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const index = model.active
  if (index === null) return []
  const x = xOf(geometry, model.props.kind, index, model.props.x.length)
  if (model.props.kind === 'bar') {
    return [h.rect([h.X(String(geometry.band * index)), h.Y('0'), h.Width(String(geometry.band)), h.Height(String(geometry.plotHeight)), h.Class('fill-muted/60')])]
  }
  return [
    h.line([h.X1(String(x)), h.X2(String(x)), h.Y1('0'), h.Y2(String(geometry.plotHeight)), h.Class('stroke-muted-foreground/60'), h.StrokeWidth('1')]),
    ...shown(model).flatMap(({ slot }, at) => {
      const segment = geometry.segments[at]?.[index]
      if (segment === undefined || segment.value === null) return []
      return [
        h.circle([
          h.Cx(String(x)),
          h.Cy(String(yOf(geometry, segment.top))),
          h.R('4'),
          h.StrokeWidth('2'),
          h.Style({ fill: color(slot), stroke: 'var(--background)' }),
        ]),
      ]
    }),
  ]
}

const tooltip = (model: Model, geometry: Layout, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const index = model.active
  if (index === null) return []
  const dates = areDates(model.props.x)
  const x = geometry.margin.left + xOf(geometry, model.props.kind, index, model.props.x.length)
  const rows = shown(model)
  const total = rows.reduce((sum, { series }) => sum + (series.values[index] ?? 0), 0)
  // Beside the active x, on the side with room.
  const onLeft = x > model.width - 200
  return [
    h.div(
      [
        h.Role('status'),
        h.DataAttribute('chart-tooltip', ''),
        h.Class('pointer-events-none absolute z-10 min-w-36 rounded-md border bg-popover px-2.5 py-2 text-[12px] text-popover-foreground shadow-md'),
        h.Style({
          top: `${geometry.margin.top}px`,
          ...(onLeft ? { right: `${model.width - x + 12}px` } : { left: `${x + 12}px` }),
        }),
      ],
      [
        h.div([h.Class('mb-1 text-[11px] text-muted-foreground')], [xTitle(model.props.x[index] ?? '', dates)]),
        ...rows.map(({ series, slot }) => {
          const value = series.values[index] ?? null
          return h.div(
            [h.Class('flex items-center gap-2')],
            [
              lineKey(slot, h),
              h.span([h.Class('font-semibold tabular-nums')], [value === null ? '–' : format(model)(value)]),
              h.span([h.Class('min-w-0 truncate text-muted-foreground')], [series.label]),
            ],
          )
        }),
        ...(model.props.stacked && rows.length > 1
          ? [
              h.div(
                [h.Class('mt-1 flex items-center gap-2 border-t pt-1')],
                [h.span([h.Class('w-3')], []), h.span([h.Class('font-semibold tabular-nums')], [format(model)(total)]), h.span([h.Class('text-muted-foreground')], ['Total'])],
              ),
            ]
          : []),
      ],
    ),
  ]
}

const keyOf = (key: string): Option.Option<Message> =>
  ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape', 'Enter'].includes(key) ? Option.some(Message.PressedKey({ key })) : Option.none()

const plot = (model: Model, h: HtmlBuilder<Message>): Html => {
  const geometry = layoutOf(model)
  const { margin } = geometry
  return h.div(
    [
      h.OnMount(TrackPlot()),
      h.Tabindex(0),
      h.Role('group'),
      h.AriaLabel(`${model.props.label}. Arrow keys move between points.`),
      h.OnKeyDownPreventDefault(keyOf),
      h.OnBlur(Message.LeftPlot()),
      h.Class(cn('relative w-full rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50', model.props.clickable && 'cursor-pointer')),
      h.Style({ height: `${model.props.height}px` }),
    ],
    [
      h.svg(
        [
          h.Xmlns('http://www.w3.org/2000/svg'),
          h.Width(String(model.width)),
          h.Height(String(model.props.height)),
          h.ViewBox(`0 0 ${model.width} ${model.props.height}`),
          h.AriaHidden(true),
          h.Class('block overflow-visible select-none'),
        ],
        [h.g([h.Attribute('transform', `translate(${margin.left},${margin.top})`)], [...hover(model, geometry, h).filter((_, at) => model.props.kind === 'bar' && at === 0), ...axes(model, geometry, h), ...marks(model, geometry, h), ...(model.props.kind === 'bar' ? [] : hover(model, geometry, h))])],
      ),
      ...tooltip(model, geometry, h),
    ],
  )
}

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('viz flex w-full flex-col gap-1.5'), h.DataAttribute('chart-kind', model.props.kind)],
    [header(model, h), model.table ? tableView(model, h) : plot(model, h)],
  )

// PROGRAM

export const makeChart = (container: HTMLElement, props: ChartProps) =>
  Runtime.makeElement({
    Model,
    Flags: ChartProps,
    flags: Effect.succeed(props),
    init,
    update,
    view,
    subscriptions,
    ports,
    container,
  })
