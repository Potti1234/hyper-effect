/* Server-side rendering of an island's host element. */

import { Option, Schema } from 'effect'
import * as CustomElement from 'foldkit/customElement'
import type { Attribute, Html, HtmlBuilder } from 'foldkit/html'

import { rewriteAttributes } from '@hyper-effect/core/binding'
import { binderOf } from '@hyper-effect/core/builder'

import { ISLAND_EVENT, type IslandSpec, PROPS_ATTRIBUTE } from './contract.ts'

export type IslandViewConfig<Props, Event, Message> = Readonly<{
  /** Stable id: morphs keep the island alive by matching it. */
  id: string
  props: Props
  /** Turns the island's events into Messages (null drops one); without
   *  it, its events are not bound (an island that only shows). */
  onEvent?: (event: Event) => Message | null
  class?: string
}>

const elementSpecs = new Map<string, CustomElement.CustomElementSpec<string, {}, {}>>()

const elementSpec = (tag: string) => {
  const existing = elementSpecs.get(tag)
  if (existing !== undefined) return existing
  const spec = CustomElement.define({ tag, properties: {}, events: {} })
  elementSpecs.set(tag, spec)
  return spec
}

/** Renders an island's host element. Its content is owned by the browser:
 *  `data-ignore-morph` keeps Datastar's morphs out of it. */
export const view = <Tag extends string, Props, Event, Message>(
  spec: IslandSpec<Tag, Props, Event>,
  config: IslandViewConfig<Props, Event, Message>,
  h: HtmlBuilder<Message>,
): Html => {
  const encodeProps = Schema.encodeUnknownSync(Schema.toCodecJson(spec.Props))
  const decodeEvent = Schema.decodeUnknownOption(Schema.toCodecJson(spec.Event))
  const onEvent = config.onEvent
  const onIslandEvent: ReadonlyArray<Attribute<Message>> =
    onEvent === undefined
      ? []
      : [
          {
            _tag: 'OnCustomEvent',
            name: ISLAND_EVENT,
            f: (event: CustomEvent<unknown>) =>
              Option.flatMap(decodeEvent(event.detail), decoded => Option.fromNullishOr(onEvent(decoded))),
          },
        ]
  const attributes: ReadonlyArray<Attribute<Message>> = [
    h.Id(config.id),
    h.Attribute(PROPS_ATTRIBUTE, JSON.stringify(encodeProps(config.props))),
    h.Class(config.class ?? 'block'),
    ...onIslandEvent,
  ]
  const root = h.div(
    [h.DataAttribute('island-root', ''), h.DataAttribute('ignore-morph', '')],
    [],
  )
  const element = elementSpec(spec.tag).withMessage(h)
  const binder = binderOf(h)
  return element(
    binder === undefined ? attributes : rewriteAttributes(attributes, binder, h),
    [root],
  )
}
