import type { Attribute, Html, HtmlBuilder } from 'foldkit/html'

import { type Member, type Priority, type Status, initials, labelById } from '../domain'
import { cn } from '@/lib/utils'

/* Linear's own glyphs: status circles and priority bars, drawn as small SVGs
   (lucide has no equivalent), plus avatars and label chips. */

const svg = <Msg>(h: HtmlBuilder<Msg>, className: string, label: string | undefined, children: ReadonlyArray<Html>): Html =>
  h.svg(
    [
      h.Xmlns('http://www.w3.org/2000/svg'),
      h.ViewBox('0 0 14 14'),
      h.Width('14'),
      h.Height('14'),
      h.Fill('none'),
      h.Class(cn('shrink-0', className)),
      ...(label === undefined ? [h.AriaHidden(true)] : [h.Role('img'), h.AriaLabel(label)]),
    ],
    children,
  )

const STATUS_COLOR: Readonly<Record<Status, string>> = {
  backlog: '#a0a3ab',
  todo: '#9ca0a8',
  in_progress: '#e5a50a',
  in_review: '#0f9f6e',
  done: '#5e6ad2',
  canceled: '#9ca0a8',
}

export const statusIcon = <Msg>(status: Status, h: HtmlBuilder<Msg>, className = '', label?: string): Html => {
  const color = STATUS_COLOR[status]
  const ring = (extra: ReadonlyArray<Attribute<Msg>> = []) =>
    h.circle([h.Cx('7'), h.Cy('7'), h.R('6'), h.Stroke(color), h.StrokeWidth('1.5'), h.Fill('none'), ...extra], [])
  switch (status) {
    case 'backlog':
      return svg(h, className, label, [ring([h.StrokeDasharray('1.4 1.74')])])
    case 'todo':
      return svg(h, className, label, [ring()])
    case 'in_progress':
      return svg(h, className, label, [ring(), h.path([h.D('M7 7 L7 3.5 A3.5 3.5 0 0 1 7 10.5 Z'), h.Fill(color)], [])])
    case 'in_review':
      return svg(h, className, label, [ring(), h.path([h.D('M7 7 L7 3.5 A3.5 3.5 0 1 1 3.5 7 Z'), h.Fill(color)], [])])
    case 'done':
      return svg(h, className, label, [
        h.circle([h.Cx('7'), h.Cy('7'), h.R('6.5'), h.Fill(color)], []),
        h.path([h.D('M4.3 7.2 L6.2 9 L9.8 5.2'), h.Stroke('white'), h.StrokeWidth('1.5'), h.StrokeLinecap('round'), h.StrokeLinejoin('round')], []),
      ])
    case 'canceled':
      return svg(h, className, label, [
        h.circle([h.Cx('7'), h.Cy('7'), h.R('6.5'), h.Fill(color)], []),
        h.path([h.D('M5 5 L9 9 M9 5 L5 9'), h.Stroke('white'), h.StrokeWidth('1.5'), h.StrokeLinecap('round')], []),
      ])
  }
}

export const priorityIcon = <Msg>(priority: Priority, h: HtmlBuilder<Msg>, className = '', label?: string): Html => {
  if (priority === 0) {
    return svg(h, className, label, [
      h.rect([h.X('1.5'), h.Y('6.25'), h.Width('3'), h.Height('1.5'), h.Rx('0.5'), h.Fill('currentColor'), h.Opacity('0.6')], []),
      h.rect([h.X('5.5'), h.Y('6.25'), h.Width('3'), h.Height('1.5'), h.Rx('0.5'), h.Fill('currentColor'), h.Opacity('0.6')], []),
      h.rect([h.X('9.5'), h.Y('6.25'), h.Width('3'), h.Height('1.5'), h.Rx('0.5'), h.Fill('currentColor'), h.Opacity('0.6')], []),
    ])
  }
  if (priority === 1) {
    return svg(h, className, label, [
      h.rect([h.X('1'), h.Y('1'), h.Width('12'), h.Height('12'), h.Rx('3'), h.Fill('#f2994a')], []),
      h.rect([h.X('6.25'), h.Y('3.5'), h.Width('1.5'), h.Height('4.5'), h.Rx('0.5'), h.Fill('white')], []),
      h.rect([h.X('6.25'), h.Y('9.25'), h.Width('1.5'), h.Height('1.5'), h.Rx('0.5'), h.Fill('white')], []),
    ])
  }
  const filled = priority === 2 ? 3 : priority === 3 ? 2 : 1
  const bar = (index: number, height: number) =>
    h.rect(
      [
        h.X(String(1.5 + index * 4)),
        h.Y(String(12.5 - height)),
        h.Width('3'),
        h.Height(String(height)),
        h.Rx('0.75'),
        h.Fill('currentColor'),
        ...(index < filled ? [] : [h.Opacity('0.25')]),
      ],
      [],
    )
  return svg(h, className, label, [bar(0, 5), bar(1, 8), bar(2, 11)])
}

export const avatar = <Msg>(member: Member | undefined, h: HtmlBuilder<Msg>, size: 'xs' | 'sm' | 'md' = 'sm', className = ''): Html => {
  const sizeClass = size === 'xs' ? 'size-4 text-[8px]' : size === 'sm' ? 'size-5 text-[9px]' : 'size-6 text-[10px]'
  if (member === undefined) {
    return h.span(
      [
        h.Class(cn('inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-muted-foreground/50', sizeClass, className)),
        h.AriaLabel('Unassigned'),
        h.Role('img'),
      ],
      [],
    )
  }
  return h.span(
    [
      h.DataAttribute('slot', 'avatar'),
      h.Class(cn('inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white', member.color, sizeClass, className)),
      h.Title(member.name),
      h.AriaLabel(member.name),
      h.Role('img'),
    ],
    [initials(member.name)],
  )
}

export const labelChip = <Msg>(labelId: string, h: HtmlBuilder<Msg>): Html => {
  const label = labelById(labelId)
  return h.span(
    [h.Class('inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium text-muted-foreground')],
    [h.span([h.Class(cn('size-2 rounded-full', label?.dot ?? 'bg-slate-400'))], []), label?.name ?? labelId],
  )
}

export const labelDot = <Msg>(labelId: string, h: HtmlBuilder<Msg>): Html => {
  const label = labelById(labelId)
  return h.span([h.Class(cn('size-2.5 shrink-0 rounded-full', label?.dot ?? 'bg-slate-400'))], [])
}

export const teamBadge = <Msg>(color: string, letter: string, h: HtmlBuilder<Msg>, className = ''): Html =>
  h.span(
    [h.Class(cn('inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px] text-[10px] font-semibold text-white', color, className))],
    [letter],
  )
