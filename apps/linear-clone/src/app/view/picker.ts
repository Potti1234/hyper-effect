import { Option, Schema as S } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import { input } from '@/ui/input'
import { kbd } from '@/ui/kbd'
import { cn } from '@/lib/utils'
import * as Icon from '@/lib/icon'

/* Linear's picker: a small filterable menu used for every property (status,
   priority, assignee, labels), for filters and for the command palette.

   Its state lives in the page's Model (open, field, query, active row), so it
   works the same from a click on a property button and from a keyboard
   shortcut. It is drawn after everything else on the page: anchored to the
   trigger with CSS anchor positioning (no measuring, so no browser code), or
   centered like a command menu when opened from the keyboard.

   crease's `command` is the visual source (classes, spacing). It is not used
   directly: on the server its Enter key does nothing (EXPERIMENT.md, F2). */

export const PickerField = S.Literals(['status', 'priority', 'assignee', 'labels', 'team', 'filter', 'command'])
export type PickerField = typeof PickerField.Type

export const Picker = S.Struct({
  field: PickerField,
  /** Issue ids the choice applies to; empty for a draft, filters or commands. */
  issueIds: S.Array(S.String),
  /** Where the choice goes: issues, the new-issue draft, the filters, or the palette. */
  target: S.Literals(['issues', 'draft', 'filter', 'palette']),
  query: S.String,
  active: S.Number,
  /** CSS anchor name of the trigger; null centers the picker. */
  anchor: S.NullOr(S.String),
})
export type Picker = typeof Picker.Type

export type PickerItem = Readonly<{
  value: string
  label: string
  group?: string
  /** Shown as a checkbox (multi-select fields) or a check mark. */
  isChecked?: boolean
  shortcut?: string
  /** Extra words the filter matches. */
  keywords?: string
}>

export const isMultiSelect = (field: PickerField): boolean => field === 'labels' || field === 'filter'

export const placeholder: Readonly<Record<PickerField, string>> = {
  status: 'Change status…',
  priority: 'Set priority…',
  assignee: 'Assign to…',
  labels: 'Add labels…',
  team: 'Choose a team…',
  filter: 'Filter by…',
  command: 'Type a command or search…',
}

/** Index of the first checked item: where a single-choice picker starts. */
export const checkedIndex = (items: ReadonlyArray<PickerItem>): number => Math.max(0, items.findIndex(item => item.isChecked === true))

export const open = (
  field: PickerField,
  target: Picker['target'],
  issueIds: ReadonlyArray<string>,
  anchor: string | null,
  /** Starts on the current value, as Linear does. */
  active = 0,
): Picker => ({ field, target, issueIds, query: '', active, anchor })

export const filterItems = (items: ReadonlyArray<PickerItem>, query: string): ReadonlyArray<PickerItem> => {
  const words = query.trim().toLowerCase().split(/\s+/).filter(word => word !== '')
  if (words.length === 0) return items
  return items.filter(item => {
    const text = `${item.label} ${item.group ?? ''} ${item.keywords ?? ''}`.toLowerCase()
    return words.every(word => text.includes(word))
  })
}

/** A key pressed in the picker's input. `move` changes the active row;
 *  `choose` picks it; `close` dismisses. */
export type PickerKey = Readonly<{ _tag: 'move'; active: number } | { _tag: 'choose'; value: string } | { _tag: 'close' } | { _tag: 'none' }>

export const keyAction = (picker: Picker, items: ReadonlyArray<PickerItem>, key: string): PickerKey => {
  const visible = filterItems(items, picker.query)
  const count = visible.length
  const active = Math.min(picker.active, Math.max(0, count - 1))
  switch (key) {
    case 'ArrowDown':
      return count === 0 ? { _tag: 'none' } : { _tag: 'move', active: (active + 1) % count }
    case 'ArrowUp':
      return count === 0 ? { _tag: 'none' } : { _tag: 'move', active: (active - 1 + count) % count }
    case 'Home':
      return { _tag: 'move', active: 0 }
    case 'End':
      return { _tag: 'move', active: Math.max(0, count - 1) }
    case 'Enter': {
      const item = visible[active]
      return item === undefined ? { _tag: 'none' } : { _tag: 'choose', value: item.value }
    }
    case 'Escape':
      return { _tag: 'close' }
    default: {
      const value = picker.query === '' ? shortcutValue(items, key) : undefined
      return value === undefined ? { _tag: 'none' } : { _tag: 'choose', value }
    }
  }
}

const PICKER_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Escape'])

/** Items with a number shortcut (status 1–6, priority 0–4) are chosen by
 *  pressing it, while nothing has been typed into the filter. */
const numberKey = (picker: Picker, items: ReadonlyArray<PickerItem>, key: string): boolean =>
  picker.query === '' && /^[0-9]$/.test(key) && items.some(item => item.shortcut === key)

export const shortcutValue = (items: ReadonlyArray<PickerItem>, key: string): string | undefined =>
  items.find(item => item.shortcut === key)?.value

export type PickerViewProps<Msg> = Readonly<{
  picker: Picker
  items: ReadonlyArray<PickerItem>
  /** Icon for an item (status circle, avatar, label dot…). */
  itemIcon: (item: PickerItem) => Html | undefined
  onQuery: (query: string) => Msg
  onKey: (key: string) => Msg
  onChoose: (value: string) => Msg
  onClose: Msg
  title?: string
}>

export const PICKER_INPUT_ID = 'picker-input'

const ITEM_CLASS =
  'relative flex h-8 w-full cursor-default items-center gap-2.5 rounded-md px-2 text-left text-[13px] outline-hidden select-none hover:bg-accent data-[active=true]:bg-accent data-[active=true]:text-accent-foreground'

export const pickerView = <Msg>(props: PickerViewProps<Msg>, h: HtmlBuilder<Msg>): Html => {
  const { picker } = props
  const visible = filterItems(props.items, picker.query)
  const active = Math.min(picker.active, Math.max(0, visible.length - 1))
  const isCentered = picker.anchor === null
  const multi = isMultiSelect(picker.field)

  const rows: Array<Html> = []
  let group: string | undefined
  visible.forEach((item, index) => {
    if (item.group !== undefined && item.group !== group) {
      group = item.group
      rows.push(h.div([h.Class('px-2 pt-2 pb-1 text-[11px] font-medium text-muted-foreground')], [item.group]))
    }
    const icon = props.itemIcon(item)
    rows.push(
      h.button(
        [
          h.Type('button'),
          h.Role('option'),
          h.Id(`picker-item-${index}`),
          h.AriaSelected(index === active),
          h.DataAttribute('active', String(index === active)),
          h.DataAttribute('value', item.value),
          h.Tabindex(-1),
          h.Class(ITEM_CLASS),
          h.OnClick(props.onChoose(item.value)),
        ],
        [
          ...(multi
            ? [
                h.span(
                  [
                    h.Class(
                      cn(
                        'flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border',
                        item.isChecked === true ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
                      ),
                    ),
                  ],
                  item.isChecked === true ? [Icon.check({ class: 'size-3' }, h)] : [],
                ),
              ]
            : []),
          ...(icon === undefined ? [] : [h.span([h.Class('flex w-4 shrink-0 justify-center text-muted-foreground')], [icon])]),
          h.span([h.Class('flex-1 truncate')], [item.label]),
          ...(!multi && item.isChecked === true ? [Icon.check({ class: 'size-4 text-muted-foreground' }, h)] : []),
          ...(item.shortcut === undefined ? [] : [kbd({ children: [item.shortcut], class: 'h-[18px] text-[11px]' }, h)]),
        ],
      ),
    )
  })

  const panel = h.div(
    [
      h.Id('picker'),
      h.Role('dialog'),
      h.AriaLabel(props.title ?? placeholder[picker.field]),
      h.DataAttribute('field', picker.field),
      h.Class(
        cn(
          'z-50 flex flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-[0_8px_30px_rgb(0_0_0/0.12)]',
          isCentered ? 'fixed top-[14vh] left-1/2 w-[min(640px,calc(100vw-32px))] -translate-x-1/2' : 'w-64',
        ),
      ),
      ...(isCentered || picker.anchor === null
        ? []
        : [
            h.Style({
              position: 'fixed',
              positionAnchor: picker.anchor,
              top: 'calc(anchor(bottom) + 4px)',
              left: 'anchor(left)',
              positionTry: 'flip-block',
              maxHeight: 'calc(100vh - 16px)',
            }),
          ]),
    ],
    [
      ...(isCentered && props.title !== undefined
        ? [h.div([h.Class('px-4 pt-3 text-[11px] font-medium text-muted-foreground')], [props.title])]
        : []),
      h.div(
        [h.Class(cn('flex items-center border-b', isCentered ? 'px-2' : 'px-1'))],
        [
          input(
            {
              id: PICKER_INPUT_ID,
              value: picker.query,
              placeholder: placeholder[picker.field],
              ariaLabel: placeholder[picker.field],
              autocomplete: 'off',
              role: 'combobox',
              onInput: props.onQuery,
              class: cn(
                'border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent',
                isCentered ? 'h-12 text-[15px] md:text-[15px]' : 'h-9 text-[13px] md:text-[13px]',
              ),
            },
            h,
          ),
        ],
      ),
      h.div(
        [h.Role('listbox'), h.AriaLabel(placeholder[picker.field]), h.Class(cn('overflow-y-auto p-1', isCentered ? 'max-h-[360px]' : 'max-h-[300px]'))],
        visible.length === 0 ? [h.div([h.Class('px-2 py-6 text-center text-[13px] text-muted-foreground')], ['No results'])] : rows,
      ),
    ],
  )

  return h.div(
    [h.Id('picker-layer'), h.Class('contents')],
    [
      h.div(
        [
          h.AriaHidden(true),
          h.Class(cn('fixed inset-0 z-40', isCentered ? 'bg-black/20 dark:bg-black/40' : '')),
          h.OnClick(props.onClose),
        ],
        [],
      ),
      // The key handler goes on the panel: keys typed in the input bubble to it.
      h.div(
        [
          h.Class('contents'),
          h.OnKeyDownPreventDefault(key =>
            PICKER_KEYS.has(key) || numberKey(picker, props.items, key) ? Option.some(props.onKey(key)) : Option.none(),
          ),
        ],
        [panel],
      ),
    ],
  )
}
