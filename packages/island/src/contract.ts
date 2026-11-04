/* The island contract, safe to import in the browser. */

import type { Schema } from 'effect'

export const ISLAND_EVENT = 'island-event'
export const PROPS_ATTRIBUTE = 'data-props'

export interface IslandSpec<Tag extends string, Props, Event> {
  readonly tag: Tag
  readonly Props: Schema.Codec<Props, unknown, never, never>
  readonly Event: Schema.Codec<Event, unknown, never, never>
}

export const define = <Tag extends `${string}-${string}`, Props, Event>(
  spec: IslandSpec<Tag, Props, Event>,
): IslandSpec<Tag, Props, Event> => spec
