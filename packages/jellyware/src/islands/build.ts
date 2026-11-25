import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'

import { build } from 'esbuild'
import { Effect, Option } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

/* Building an extension's islands and serving their frames.

   Each island is bundled with esbuild into one module for the browser: its
   files, Effect, Foldkit and what it imports from the app, minified. The
   code is kept in memory by its hash; the frame's address names the hash,
   so a frame is cached for good and a new version gets a new address.

   A frame is a small page that holds the module inline. Its content
   security policy runs that script only (by nonce), loads styles from the
   app's stylesheets, and allows no network at all: no fetch, no
   WebSocket, no images from elsewhere. Embedded with `sandbox=
   "allow-scripts"`, it also has an opaque origin. */

export class IslandBuildError extends Error {}

/** Bundles one island; fails with esbuild's messages. */
export const buildIsland = (entry: string, options: Readonly<{ tsconfig?: string }> = {}) =>
  Effect.tryPromise({
    try: async () => {
      const result = await build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        minify: true,
        legalComments: 'none',
        logLevel: 'silent',
        ...(options.tsconfig === undefined ? {} : { tsconfig: options.tsconfig }),
        define: { 'process.env.NODE_ENV': '"production"' },
      })
      const code = result.outputFiles[0]?.text ?? ''
      return { code, hash: createHash('sha256').update(code).digest('hex').slice(0, 16) }
    },
    catch: error => {
      const errors = typeof error === 'object' && error !== null && 'errors' in error && Array.isArray(error.errors) ? error.errors : []
      const lines = errors.map((each: unknown) => {
        if (typeof each !== 'object' || each === null) return String(each)
        const text = 'text' in each ? String(each.text) : ''
        const location = 'location' in each && typeof each.location === 'object' && each.location !== null ? each.location : null
        const file = location !== null && 'file' in location ? String(location.file) : ''
        const line = location !== null && 'line' in location ? String(location.line) : ''
        return `${file}${line === '' ? '' : `:${line}`}: ${text}`
      })
      return new IslandBuildError(lines.length > 0 ? lines.join('\n') : String(error))
    },
  })

/** Where a built island's frame is served. */
export const frameSrc = (extension: string, name: string, hash: string) =>
  `/_jellyware/islands/${encodeURIComponent(extension)}/${encodeURIComponent(name)}/${hash}`

const escapeScript = (code: string) => code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--')

const escapeAttribute = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** The frame's page and its policy. `origin` is the app's, for its
 *  stylesheets (an opaque origin has no 'self'). */
export const framePage = (code: string, options: Readonly<{ origin: string; stylesheets: ReadonlyArray<string> }>) => {
  const nonce = randomBytes(16).toString('base64')
  const styles = options.stylesheets.map(href => `<link rel="stylesheet" href="${escapeAttribute(options.origin + href)}">`).join('')
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
    styles +
    '<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style></head>' +
    `<body class="text-foreground"><div id="island"></div><script type="module" nonce="${nonce}">${escapeScript(code)}</script></body></html>`
  const policy = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src ${options.origin} 'unsafe-inline'`,
    `font-src ${options.origin} data:`,
    'img-src data: blob:',
    "connect-src 'none'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
  return { html, policy }
}

/** The route that serves frames, from what the loader built
 *  (`Extensions.islandCode`). */
export const frameRoute = <E, R>(
  options: Readonly<{
    codeOf: (extension: string, name: string, hash: string) => Effect.Effect<Option.Option<string>, E, R>
    stylesheets: ReadonlyArray<string>
  }>,
) =>
  HttpRouter.add(
    'GET',
    '/_jellyware/islands/:extension/:name/:hash',
    Effect.gen(function* () {
      const { extension = '', name = '', hash = '' } = yield* HttpRouter.params
      const code = yield* options.codeOf(extension, name, hash)
      if (Option.isNone(code)) return HttpServerResponse.text('No such island.', { status: 404 })
      const request = yield* HttpServerRequest.HttpServerRequest
      const host = request.headers['host'] ?? 'localhost'
      const forwarded = request.headers['x-forwarded-proto']
      const origin = `${forwarded === 'https' ? 'https' : 'http'}://${host}`
      const page = framePage(code.value, { origin, stylesheets: options.stylesheets })
      return HttpServerResponse.html(page.html).pipe(
        HttpServerResponse.setHeaders({
          'content-security-policy': page.policy,
          'cache-control': 'private, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        }),
      )
    }),
  )

/** Where an island's entry is: in the extension's folder, never outside. */
export const entryOf = (folder: string, path: string): string | null => {
  const normalized = path.replace(/\\/g, '/')
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) return null
  return join(folder, normalized)
}
