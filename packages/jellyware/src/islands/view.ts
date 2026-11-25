import { Context, type Effect, Schema as S } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import * as Island from '@hyper-effect/island'

import { HOST_TAG, type IslandSpec } from './contract.ts'

/* On the server: what an extension renders for one of its islands, and
   where it finds the frame of the version that runs. */

/** The frames of the extension's islands, as built for the version that
 *  runs; read while building its layer and handed to its pages. */
export class ExtensionIslands extends Context.Service<
  ExtensionIslands,
  {
    /** The address of an island's frame (extension.json's `"islands"`). */
    readonly src: (name: string) => Effect.Effect<string>
  }
>()('@hyper-effect/jellyware/ExtensionIslands') {}

export type IslandViewConfig<Props, Event, Message> = Readonly<{
  /** Stable and unique on the page: the frame lives as long as it does. */
  id: string
  /** From `ExtensionIslands.src(name)`. */
  src: string
  props: Props
  /** What the frame is, for screen readers. */
  label: string
  /** In pixels; without it, the frame is as tall as its content. */
  height?: number
  /** Turns the island's events into Messages (null drops one). They come
   *  from the browser: check them in update. */
  onEvent?: (event: Event) => Message | null
  class?: string
}>

/** The host element of an island, with its props; the page binds its
 *  events like any island's. */
export const islandView = <Props, Event, Message>(
  spec: IslandSpec<Props, Event>,
  config: IslandViewConfig<Props, Event, Message>,
  h: HtmlBuilder<Message>,
): Html =>
  Island.view(
    {
      tag: HOST_TAG,
      Props: S.Struct({ src: S.String, height: S.NullOr(S.Number), label: S.String, props: spec.Props }),
      Event: spec.Event,
    },
    {
      id: config.id,
      props: { src: config.src, height: config.height ?? null, label: config.label, props: config.props },
      ...(config.onEvent === undefined ? {} : { onEvent: config.onEvent }),
      class: config.class ?? 'block w-full',
    },
    h,
  )
