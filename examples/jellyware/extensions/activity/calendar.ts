import { Effect, Match as M, Option, Schema as S } from 'effect'
import { Command, Port, Runtime, Subscription, type Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import { islandPorts } from '@hyper-effect/jellyware/island'

import { Calendar, CalendarEvent, CalendarProps, type Day } from './contract.ts'

/* The calendar: a week per column, a day per cell, darker the more changed
   that day. The hovered or focused day shows a tooltip; a click reports
   the day to the page. It runs in the browser, in a sandboxed frame
   (calendar.island.ts starts it there). */

// MODEL

export const Model = S.Struct({
  props: CalendarProps,
  /** The day under the pointer or the keyboard. */
  active: S.NullOr(S.Number),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ReceivedProps: { props: CalendarProps },
  HoveredDay: { index: S.Number },
  LeftCalendar: {},
  ClickedDay: { index: S.Number },
  PressedKey: { key: S.String },
  CompletedEmit: {},
})
export type Message = typeof Message.Type

export const ports = islandPorts(Calendar)

export const Emit = Command.define('ActivityEmit', {
  args: { event: CalendarEvent },
  messages: [Message.CompletedEmit],
  execute: ({ event }) => Port.emit(ports.outbound.events, event).pipe(Effect.as(Message.CompletedEmit())),
})

export const init = (props: CalendarProps): Update.Return<Model, Message> => ({ model: { props, active: null } })

// UPDATE

const clicked = (model: Model, index: number): Update.Return<Model, Message> => {
  const day = model.props.days[index]
  return day === undefined
    ? { model }
    : { model: { ...model, active: index }, commands: [Emit({ event: CalendarEvent.members[0].make({ date: day.date }) })] }
}

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  M.value(message).pipe(
    M.withReturnType<Update.Return<Model, Message>>(),
    M.tagsExhaustive({
      ReceivedProps: ({ props }) => ({ model: { ...model, props, active: model.active !== null && model.active < props.days.length ? model.active : null } }),
      HoveredDay: ({ index }) => ({ model: { ...model, active: index } }),
      LeftCalendar: () => ({ model: { ...model, active: null } }),
      ClickedDay: ({ index }) => clicked(model, index),
      // Left and right move a week, up and down a day.
      PressedKey: ({ key }) => {
        const last = model.props.days.length - 1
        if (last < 0) return { model }
        if (key === 'Enter' || key === ' ') return model.active === null ? { model } : clicked(model, model.active)
        const step = key === 'ArrowRight' ? 7 : key === 'ArrowLeft' ? -7 : key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0
        if (key === 'Escape') return { model: { ...model, active: null } }
        const from = model.active ?? last
        return { model: { ...model, active: Math.min(last, Math.max(0, from + step)) } }
      },
      CompletedEmit: () => ({ model }),
    }),
  )

export const subscriptions = Subscription.make<Model, Message>()(_entry => ({
  props: Port.subscriptionEntry(ports.inbound.props, props => Message.ReceivedProps({ props })),
}))

// VIEW

/** One blue, light to dark (the sequential ramp of the app's charts). */
const STEPS = ['bg-muted', 'bg-[#b7d3f6]', 'bg-[#6da7ec]', 'bg-[#2a78d6]', 'bg-[#184f95]'] as const

/** The step of a day: none, then quartiles of the busiest day. */
export const stepOf = (changes: number, busiest: number): number =>
  changes === 0 || busiest === 0 ? 0 : Math.min(4, 1 + Math.floor(((changes - 1) / busiest) * 4))

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Mon', '', 'Wed', '', 'Fri', '', '']

const label = (date: string) => {
  const [year = '', month = '1', day = '1'] = date.split('-')
  return `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`
}

const tooltip = (day: Day, index: number, h: HtmlBuilder<Message>): Html => {
  const week = Math.floor(index / 7)
  return h.div(
    [
      h.Role('status'),
      h.DataAttribute('calendar-tooltip', ''),
      h.Class('pointer-events-none absolute z-10 rounded-md border bg-popover px-2.5 py-1.5 text-[12px] whitespace-nowrap text-popover-foreground shadow-md'),
      h.Style({ left: `${Math.max(0, 32 + week * 16 - 40)}px`, top: '0px' }),
    ],
    [
      h.div([h.Class('text-[11px] text-muted-foreground')], [label(day.date)]),
      h.div([], [h.span([h.Class('font-semibold tabular-nums')], [String(day.changes)]), ` change${day.changes === 1 ? '' : 's'}`]),
      ...(day.done === 0 ? [] : [h.div([], [h.span([h.Class('font-semibold tabular-nums')], [String(day.done)]), ' done'])]),
    ],
  )
}

const keyOf = (key: string): Option.Option<Message> =>
  ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' ', 'Escape'].includes(key) ? Option.some(Message.PressedKey({ key })) : Option.none()

export const view = (model: Model, h: HtmlBuilder<Message>): Html => {
  const days = model.props.days
  const busiest = Math.max(0, ...days.map(day => day.changes))
  const weeks = Math.ceil(days.length / 7)
  const active = model.active === null ? undefined : days[model.active]
  return h.div(
    [h.Class('relative select-none px-1 pt-14 pb-1 font-sans')],
    [
      ...(active === undefined || model.active === null ? [] : [tooltip(active, model.active, h)]),
      h.div(
        [
          h.Role('grid'),
          h.AriaLabel('Activity per day. Arrow keys move, Enter lists a day.'),
          h.Tabindex(0),
          h.OnKeyDownPreventDefault(keyOf),
          h.OnMouseLeave(Message.LeftCalendar()),
          h.Class('flex gap-[3px] rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50'),
        ],
        [
          h.div(
            [h.Class('mr-1 grid grid-rows-7 gap-[3px] text-[10px] leading-[13px] text-muted-foreground')],
            WEEKDAYS.map(name => h.span([h.Class('h-[13px]')], [name])),
          ),
          ...Array.from({ length: weeks }, (_, week) =>
            h.div(
              [h.Class('grid grid-rows-7 gap-[3px]')],
              days.slice(week * 7, week * 7 + 7).map((day, offset) => {
                const index = week * 7 + offset
                return h.button(
                  [
                    h.Type('button'),
                    h.Tabindex(-1),
                    h.DataAttribute('date', day.date),
                    h.AriaLabel(`${label(day.date)}: ${day.changes} changes, ${day.done} done`),
                    h.OnMouseEnter(Message.HoveredDay({ index })),
                    h.OnClick(Message.ClickedDay({ index })),
                    h.Class(
                      [
                        'size-[13px] rounded-[3px] transition-shadow',
                        STEPS[stepOf(day.changes, busiest)] ?? STEPS[0],
                        model.props.selected === day.date ? 'ring-2 ring-foreground ring-offset-1 ring-offset-background' : '',
                        model.active === index ? 'ring-2 ring-primary/70' : '',
                      ].join(' '),
                    ),
                  ],
                  [],
                )
              }),
            ),
          ),
        ],
      ),
      h.div(
        [h.Class('mt-2 flex items-center justify-end gap-1 text-[10.5px] text-muted-foreground')],
        ['Less', ...STEPS.map(step => h.span([h.Class(`size-[11px] rounded-[2px] ${step}`)], [])), 'More'],
      ),
    ],
  )
}

export const makeCalendar = (container: HTMLElement, props: CalendarProps) =>
  Runtime.makeElement({
    Model,
    Flags: CalendarProps,
    flags: Effect.succeed(props),
    init,
    update,
    view,
    subscriptions,
    ports,
    container,
  })
