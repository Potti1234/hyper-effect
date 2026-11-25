import type { Schema } from 'effect'
import { Port } from 'foldkit'

/* An extension's own browser code: an island, a Foldkit program that runs
   in a sandboxed frame inside one of its pages. Safe to import on the
   server and in the browser.

   The contract is two Schemas, as for the app's islands: `Props` go from
   the page to the island (whenever the page renders new ones), `Event`
   from the island to the page, where they become Messages. Between the
   page and the frame they travel as `postMessage`s:

   page → frame   { type: 'props', props }   the props, encoded as JSON
                  { type: 'theme', dark }     the page's colour scheme
   frame → page   { type: 'ready' }           ready for props
                  { type: 'event', detail }   an event, encoded as JSON
                  { type: 'height', height }  the content's height in px
                  { type: 'error', message }  the island failed */

export interface IslandSpec<Props, Event> {
  /** Its key in extension.json's `"islands"`. */
  readonly name: string
  readonly Props: Schema.Codec<Props, unknown, never, never>
  readonly Event: Schema.Codec<Event, unknown, never, never>
}

export const defineIsland = <Props, Event>(spec: IslandSpec<Props, Event>): IslandSpec<Props, Event> => spec

/** The ports an island's program declares (`Runtime.makeElement({ ports })`). */
export const islandPorts = <Props, Event>(spec: IslandSpec<Props, Event>) => ({
  inbound: { props: Port.inbound(spec.Props) },
  outbound: { events: Port.outbound(spec.Event) },
})

/** The element that hosts an extension's island in a page. */
export const HOST_TAG = 'jellyware-island'

/** The highest a frame grows to fit its content. */
export const MAX_FRAME_HEIGHT = 4000

export type ToFrame = Readonly<{ type: 'props'; props: unknown }> | Readonly<{ type: 'theme'; dark: boolean }>

export type FromFrame =
  | Readonly<{ type: 'ready' }>
  | Readonly<{ type: 'event'; detail: unknown }>
  | Readonly<{ type: 'height'; height: number }>
  | Readonly<{ type: 'error'; message: string }>

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null

/** A message from a frame, when it is one. */
export const fromFrame = (data: unknown): FromFrame | null => {
  if (!isRecord(data)) return null
  switch (data['type']) {
    case 'ready':
      return { type: 'ready' }
    case 'event':
      return { type: 'event', detail: data['detail'] }
    case 'height':
      return typeof data['height'] === 'number' && Number.isFinite(data['height']) ? { type: 'height', height: data['height'] } : null
    case 'error':
      return { type: 'error', message: String(data['message'] ?? 'The island failed.') }
    default:
      return null
  }
}

/** A message from the page, when it is one. */
export const toFrame = (data: unknown): ToFrame | null => {
  if (!isRecord(data)) return null
  if (data['type'] === 'props') return { type: 'props', props: data['props'] }
  if (data['type'] === 'theme') return { type: 'theme', dark: data['dark'] === true }
  return null
}
