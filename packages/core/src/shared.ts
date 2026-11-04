import type { Html, HtmlBuilder } from 'foldkit/html'

import type { Binder } from './binding'
import { binderOf, withBinder } from './builder'
import { sameDeps } from './deps'
import { serializeHtml } from './foldkit-internal'
import { withRegions } from './region'

/* Render once, serve many. Every live page re-renders on every shared change,
   so markup that depends only on shared data (the incident list, a
   leaderboard, a feed) is rendered once per distinct `deps` and reused, as a
   string, by every session that shows it.

   The view gets a placeholder element; after the page is serialized the
   placeholder is replaced by the cached markup. (Handing Foldkit the markup
   as InnerHTML would be simpler, but its serializer re-parses InnerHTML to
   validate it, which costs more than rendering the rows.)

   Shared markup must not depend on the session: it may bind Messages (their
   tokens are session-independent; the endpoint lives in a page signal) but
   not function handlers or client-owned inputs, which belong to one
   session's handler table. Rendering one inside `shared` fails. */

const SHARED_ATTRIBUTE = 'data-hyper-shared'
const CACHE_CAPACITY = 1000

type Entry = Readonly<{ deps: ReadonlyArray<unknown>; html: string }>

const cache = new Map<string, Entry>()
let hits = 0
let misses = 0

export const sharedStats = () => ({ hits, misses, entries: cache.size })

/** A binder for markup every session reuses: Messages only. */
export const sessionIndependent = <Message>(binder: Binder<Message>): Binder<Message> => ({
  endpoint: '',
  bindMessage: message => {
    const fields = binder.bindMessage(message)
    if (!fields.startsWith('m:')) {
      throw new Error('hyper-effect: shared markup can only bind JSON-encodable Messages.')
    }
    return fields
  },
  registerHandler: () => {
    throw new Error(
      'hyper-effect: shared markup can only bind Messages; a function handler belongs to one session.',
    )
  },
  registerInput: () => {
    throw new Error('hyper-effect: shared markup cannot contain client-owned inputs.')
  },
})

// Placeholders of the render in progress: token → markup.
let slots: Map<string, string> | undefined

/** Runs a render, collecting the shared markup its view placed. */
export const collectShared = <A>(render: () => A): Readonly<{ result: A; slots: Map<string, string> }> => {
  const outer = slots
  const collected = new Map<string, string>()
  slots = collected
  try {
    return { result: render(), slots: collected }
  } finally {
    slots = outer
  }
}

/** Replaces the placeholders in serialized markup. */
export const fillShared = (html: string, collected: ReadonlyMap<string, string>): string => {
  let filled = html
  for (const [token, markup] of collected) {
    const placeholder = `<template ${SHARED_ATTRIBUTE}="${token}"></template>`
    const at = filled.indexOf(placeholder)
    if (at !== -1) {
      filled = filled.slice(0, at) + markup + filled.slice(at + placeholder.length)
    }
  }
  return filled
}

/** `render()`'s children, rendered once per `key` and `deps` (compared by
 *  value, see `deps.ts`) and shared by every session. `deps` must determine the markup
 *  completely: a version that is unique per data source and change, plus
 *  every view input. Place the result as the children of its container:
 *
 *  ```ts
 *  h.ul([h.Class('grid gap-2')], [
 *    shared(h, {
 *      key: 'incident-rows',
 *      deps: [model.version, model.filter],
 *      render: () => incidents.map(incident => row(incident, h)),
 *    }),
 *  ])
 *  ``` */
export const shared = <Message>(
  h: HtmlBuilder<Message>,
  config: Readonly<{
    key: string
    deps: ReadonlyArray<unknown>
    render: () => ReadonlyArray<Html | string>
  }>,
): Html => {
  const binder = binderOf(h)
  if (binder === undefined || slots === undefined) {
    throw new Error('hyper-effect: shared markup is for server-rendered views.')
  }
  const cached = cache.get(config.key)
  let html: string
  if (cached !== undefined && sameDeps(cached.deps, config.deps)) {
    hits += 1
    // Refresh recency for the LRU.
    cache.delete(config.key)
    cache.set(config.key, cached)
    html = cached.html
  } else {
    misses += 1
    // Regions belong to one session; in markup every session reuses they
    // render in place.
    const wrapper = withRegions(undefined, () =>
      withBinder(sessionIndependent(binder), () => h.div([], config.render())),
    )
    html = serializeHtml(wrapper).slice('<div>'.length, -'</div>'.length)
    cache.set(config.key, { deps: config.deps, html })
    if (cache.size > CACHE_CAPACITY) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
  }
  const token = `s${slots.size}`
  slots.set(token, html)
  return h.template([h.Attribute(SHARED_ATTRIBUTE, token)], [])
}
