import { Option, Schema as S } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import * as Icon from '@/lib/icon'

import {
  type Issue,
  type IssueChange,
  LABELS,
  type Member,
  PRIORITIES,
  Priority,
  STATUSES,
  Status,
  TEAMS,
  TeamKey,
  firstName,
  priorityLabel,
  statusLabel,
} from '../domain'
import { avatar, labelDot, priorityIcon, statusIcon, teamBadge } from './icons'
import type { PickerField, PickerItem } from './picker'

/* Picker items for issue properties, shared by every page: what can be
   chosen, which is checked, its icon, and what a choice changes. */

const PRIORITY_ORDER: ReadonlyArray<Priority> = [0, 1, 2, 3, 4]

/** The values the given issues share for a property (all of them must agree). */
const shared = <A>(issues: ReadonlyArray<Issue>, read: (issue: Issue) => A): A | undefined => {
  const first = issues[0]
  if (first === undefined) return undefined
  const value = read(first)
  return issues.every(issue => read(issue) === value) ? value : undefined
}

export type PropertyValues = Readonly<{
  status: Status | undefined
  priority: Priority | undefined
  assigneeId: string | null | undefined
  /** Labels every target has. */
  labelIds: ReadonlyArray<string>
  team?: TeamKey
}>

export const valuesOf = (issues: ReadonlyArray<Issue>): PropertyValues => ({
  status: shared(issues, issue => issue.status),
  priority: shared(issues, issue => issue.priority),
  assigneeId: shared(issues, issue => issue.assigneeId),
  labelIds: LABELS.map(label => label.id).filter(id => issues.length > 0 && issues.every(issue => issue.labelIds.includes(id))),
})

export const propertyItems = (
  field: PickerField,
  values: PropertyValues,
  members: ReadonlyArray<Member>,
  me: Member,
): ReadonlyArray<PickerItem> => {
  switch (field) {
    case 'status':
      return STATUSES.map((status, index) => ({
        value: status,
        label: statusLabel[status],
        isChecked: values.status === status,
        shortcut: String(index + 1),
      }))
    case 'priority':
      return PRIORITY_ORDER.map((priority, index) => ({
        value: String(priority),
        label: priorityLabel[priority],
        isChecked: values.priority === priority,
        shortcut: String(index),
      }))
    case 'assignee':
      return [
        { value: 'none', label: 'No assignee', isChecked: values.assigneeId === null },
        ...[me, ...members.filter(member => member.id !== me.id)].map(member => ({
          value: member.id,
          label: member.id === me.id ? `${member.name} (you)` : member.name,
          keywords: firstName(member.name),
          isChecked: values.assigneeId === member.id,
        })),
      ]
    case 'labels':
      return LABELS.map(label => ({ value: label.id, label: label.name, isChecked: values.labelIds.includes(label.id) }))
    case 'team':
      return TEAMS.map(team => ({ value: team.key, label: team.name, keywords: team.key, isChecked: values.team === team.key }))
    default:
      return []
  }
}

export const propertyIcon = <Msg>(
  field: PickerField,
  value: string,
  members: ReadonlyArray<Member>,
  h: HtmlBuilder<Msg>,
): Html | undefined => {
  switch (field) {
    case 'status':
      return Option.match(S.decodeUnknownOption(Status)(value), { onNone: () => undefined, onSome: status => statusIcon(status, h) })
    case 'priority':
      return Option.match(S.decodeUnknownOption(Priority)(Number(value)), { onNone: () => undefined, onSome: priority => priorityIcon(priority, h) })
    case 'assignee':
      return avatar(members.find(member => member.id === value), h, 'xs')
    case 'labels':
      return labelDot(value, h)
    case 'team': {
      const team = TEAMS.find(candidate => candidate.key === value)
      return team === undefined ? undefined : teamBadge(team.color, team.key.charAt(0), h, 'size-4 text-[9px]')
    }
    default:
      return Icon.icon('arrow-right', { class: 'size-3.5' }, h)
  }
}

const decodeStatus = S.decodeUnknownOption(Status)
const decodePriority = S.decodeUnknownOption(Priority)

/** What choosing `value` in a property picker changes on the given issues,
 *  or None for a value the browser made up. Labels toggle: a label every
 *  issue has is removed from all, otherwise added to all. */
export const patchFor = (
  field: PickerField,
  value: string,
  issues: ReadonlyArray<Issue>,
  members: ReadonlyArray<Member>,
): Option.Option<ReadonlyArray<IssueChange>> => {
  const all = (patch: IssueChange['patch']) => issues.map(issue => ({ id: issue.id, patch }))
  switch (field) {
    case 'status':
      return Option.map(decodeStatus(value), status => all({ status }))
    case 'priority':
      return Option.map(decodePriority(Number(value)), priority => all({ priority }))
    case 'assignee':
      return value === 'none'
        ? Option.some(all({ assigneeId: null }))
        : members.some(member => member.id === value)
          ? Option.some(all({ assigneeId: value }))
          : Option.none()
    case 'labels': {
      if (!LABELS.some(label => label.id === value)) return Option.none()
      const hasAll = issues.every(issue => issue.labelIds.includes(value))
      return Option.some(
        issues.map(issue => ({
          id: issue.id,
          patch: { labelIds: hasAll ? issue.labelIds.filter(id => id !== value) : [...new Set([...issue.labelIds, value])] },
        })),
      )
    }
    default:
      return Option.none()
  }
}

export const PRIORITY_VALUES = PRIORITIES
export const decodeTeam = S.decodeUnknownOption(TeamKey)
