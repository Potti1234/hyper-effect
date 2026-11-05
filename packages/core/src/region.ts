import type { Html, HtmlBuilder } from 'foldkit/html'

import { assertNoDroppedHandlers, binderOf, withBinder } from './builder'
import { registerGauge } from './metrics'
import { sameDeps } from './deps'
import { serializeHtml } from './foldkit-internal'
import { collectShared, fillShared, sessionIndependent } from './shared'

/* Regions: render and send only what changed.

   A region is one element of the page with its own id, re-rendered only when
   its `deps` change. The session keeps each region's markup, handler table and
   client-owned inputs; a render whose region deps are unchanged skips the
   region's view entirely. The page around the regions (the frame) is still
   rendered every time. When the frame is unchanged too, the stream sends only
   the regions that changed, each morphed by id, instead of the whole page.

   Regions nest. A region that renders again evaluates its nested regions
   again: unchanged ones are kept, changed ones render. A region's version
   changes only when its own markup (nested regions as placeholders) does, so
   a list can render again around one changed row and only the row is sent.

   Like `shared`, the view gets a placeholder, filled in after serialization.
   Unlike `shared`, a region belongs to one session: it may bind function
   handlers and client-owned inputs. Inside `shared` markup, which every
   session reuses, a region renders in place. */

export const REGION_ATTRIBUTE = 'data-hyper-region'

/** The session side: places a region in the render in progress. `build`
 *  renders and serializes it; it is called only when the region must be
 *  rendered again. */
export type RegionHost = Readonly<{
  /** Names the program, for markup cached across its sessions. */
  scope: string
  place: (id: string, deps: ReadonlyArray<unknown>, build: () => string) => void
}>

// Markup of shared regions, across sessions: per program and region id, the
// last few deps seen (a row selected in one session, not in another).
const SHARED_VARIANTS = 8
const SHARED_KEYS = 5000
const sharedRegions = new Map<string, Array<Readonly<{ deps: ReadonlyArray<unknown>; html: string }>>>()
let sharedHits = 0
let sharedMisses = 0

export const sharedRegionStats = () => ({ hits: sharedHits, misses: sharedMisses, keys: sharedRegions.size })
registerGauge('sharedRegionKeys', () => sharedRegions.size)

/** In production, shared regions come from the cache. In development they
 *  are rendered every time, so the deps check compares real renders, and
 *  each render is compared with the cached one for the same deps, whichever
 *  session rendered it. Mutable for tests only. */
export const sharedRegionCache = { enabled: process.env['NODE_ENV'] === 'production' }

const cachedShared = (
  id: string,
  key: string,
  deps: ReadonlyArray<unknown>,
  render: () => string,
): string => {
  const variants = sharedRegions.get(key) ?? []
  const found = variants.find(variant => sameDeps(variant.deps, deps))
  if (found !== undefined && sharedRegionCache.enabled) {
    sharedHits += 1
    return found.html
  }
  const html = render()
  // A session's own deps check cannot see data that is constant within the
  // session, such as the user's name; shared, it would reach other users.
  if (found !== undefined) {
    if (found.html !== html) {
      throw new Error(
        `hyper-effect: shared region "${id}" renders differently with the same deps, for another session or later. It reads data its deps miss (the user, a selection, the time); add it to the deps, or drop shared.`,
      )
    }
    return html
  }
  sharedMisses += 1
  sharedRegions.delete(key)
  sharedRegions.set(key, [{ deps, html }, ...variants].slice(0, SHARED_VARIANTS))
  if (sharedRegions.size > SHARED_KEYS) {
    const oldest = sharedRegions.keys().next().value
    if (oldest !== undefined) sharedRegions.delete(oldest)
  }
  return html
}

/** A region on the page after a render: its markup with nested regions
 *  filled in, the version of its own markup, and the region it is nested in. */
export type RenderedRegion = Readonly<{
  html: string
  version: number
  parent: string | undefined
}>

let host: RegionHost | undefined

/** Runs a render with `regionHost` receiving its regions. */
export const withRegions = <A>(regionHost: RegionHost | undefined, render: () => A): A => {
  const outer = host
  host = regionHost
  try {
    return render()
  } finally {
    host = outer
  }
}

const PLACEHOLDER = new RegExp(`<template ${REGION_ATTRIBUTE}="([^"]+)"></template>`, 'g')

/** Replaces region placeholders in serialized markup with the regions' markup. */
export const fillRegions = (html: string, markupOf: (id: string) => string | undefined): string =>
  html.replace(PLACEHOLDER, (placeholder, id: string) => markupOf(id) ?? placeholder)

const REGION_ID = /^[A-Za-z][\w-]*$/

const CHECK_REGION_ID = process.env['NODE_ENV'] !== 'production'

/** The first tag of serialized markup. Attribute values may contain `>`
 *  (Tailwind's `has-[>img]`), so quoted values are skipped. */
const openingTag = (html: string): string => {
  let quote: string | undefined
  for (let index = 0; index < html.length; index += 1) {
    const char = html[index]
    if (quote !== undefined) {
      if (char === quote) quote = undefined
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return html.slice(0, index + 1)
    }
  }
  return html
}

/** One element of the page, re-rendered (and re-sent) only when `deps`
 *  change, compared by value (see `deps.ts`). `render` returns a single element with
 *  `h.Id(id)`: Datastar morphs the region into the element with that id.
 *  `deps` must determine the markup completely, nested regions included (a
 *  region whose deps are unchanged keeps its nested regions as they are).
 *  Outside production, every unchanged region is rendered anyway and
 *  compared, so missing deps fail loudly:
 *
 *  ```ts
 *  region(h, {
 *    id: 'activity',
 *    deps: [model.activity],
 *    render: () => h.section([h.Id('activity')], model.activity.map(item => h.p([], [item.text]))),
 *  })
 *  ```
 *
 *  Outside a live session (a plain `renderModel`, Foldkit's own runtime, a
 *  Scene test), the region renders in place, so views stay portable. */
export const region = <Message>(
  h: HtmlBuilder<Message>,
  config: Readonly<{
    id: string
    deps: ReadonlyArray<unknown>
    render: () => Html
    /** Render once per deps for every session of the program, not once per
     *  session. Only for regions that bind Messages alone (no function
     *  handlers, no client-owned inputs), which every session can reuse;
     *  rendering one that does not fails. Regions nested in it render in
     *  place. Its deps must determine its markup for every session: outside
     *  production, each render is compared with the markup rendered for the
     *  same deps before, in any session, so a shared region that reads the
     *  user or other session data fails loudly instead of leaking it. */
    shared?: boolean
  }>,
): Html => {
  if (!REGION_ID.test(config.id)) {
    throw new Error(`hyper-effect: region id "${config.id}" must be a plain HTML id.`)
  }
  // Outside a live session, or with Foldkit's own builder (a browser
  // runtime, Scene tests), a region is just its element.
  const binder = binderOf(h)
  if (host === undefined || binder === undefined) {
    return config.render()
  }
  const regionHost = host
  const renderOwn = config.shared === true
    ? () => withRegions(undefined, () => withBinder(sessionIndependent(binder), config.render))
    : config.render
  const build = () => {
    // Shared markup inside the region is filled now: the region's markup
    // outlives this render, its shared placeholders would not.
    const { result, slots } = collectShared(renderOwn)
    assertNoDroppedHandlers(result)
    const html = fillShared(serializeHtml(result), slots)
    // A contract check, like the deps check: outside production only.
    if (CHECK_REGION_ID) {
      const opening = openingTag(html)
      if (!opening.includes(` id="${config.id}"`)) {
        throw new Error(
          `hyper-effect: region "${config.id}" must render one element with h.Id('${config.id}'), got ${opening}`,
        )
      }
    }
    return html
  }
  regionHost.place(
    config.id,
    config.deps,
    config.shared === true
      ? () => cachedShared(config.id, `${regionHost.scope}:${config.id}`, config.deps, build)
      : build,
  )
  return h.template([h.Attribute(REGION_ATTRIBUTE, config.id)], [])
}
