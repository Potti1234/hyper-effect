import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Html } from 'foldkit/html'

/* Foldkit's vnode serializer, which `renderToString` uses internally. The
   public `renderToString` also re-parses its output with parse5 to validate
   it (raw InnerHTML fragments, document-structure escapes, hydration shape);
   on a server that re-renders a page per change, that check is ~70% of the
   cost. hyper-effect validates in development and tests and serializes
   directly in production.

   Upstream ask: export `serializeHtml` (or `renderToString({ validate: false })`)
   so this deep import can go. Pinned to the Foldkit version in package.json. */

type SerializeHtml = (root: Html) => string

const SERIALIZER = join('foldkit', 'dist', 'experimental', 'server', 'serialize.js')

// Foldkit's `exports` map hides both this file and package.json, so walk the
// same node_modules directories Node would search.
const serializerPath = (createRequire(import.meta.url).resolve.paths('foldkit') ?? [])
  .map(directory => join(directory, SERIALIZER))
  .find(candidate => existsSync(candidate))

if (serializerPath === undefined) {
  throw new Error('hyper-effect: could not locate Foldkit\'s serializer; check the pinned Foldkit version.')
}

const serializeModule: { serializeHtml: SerializeHtml } = await import(
  pathToFileURL(serializerPath).href
)

export const serializeHtml: SerializeHtml = serializeModule.serializeHtml
