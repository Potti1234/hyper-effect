/* Datastar SSE wire format. See https://data-star.dev/reference/sse_events */

/** A `datastar-patch-elements` event in the default `outer` mode: every
 *  top-level element in `html` is morphed into the element with the same id. */
export const patchElements = (html: string): string =>
  'event: datastar-patch-elements\n' +
  html
    .split('\n')
    .map(line => `data: elements ${line}`)
    .join('\n') +
  '\n\n'

/** A `datastar-patch-signals` event merging `signals` into the page's signals. */
export const patchSignals = (signals: Readonly<Record<string, unknown>>): string =>
  `event: datastar-patch-signals\ndata: signals ${JSON.stringify(signals)}\n\n`

/** A `datastar-patch-elements` event appending a hidden element to the body
 *  whose `data-init` runs `expression` once. `expression` must not contain
 *  double quotes or user content. */
export const runOnce = (expression: string): string =>
  'event: datastar-patch-elements\n' +
  'data: selector body\n' +
  'data: mode append\n' +
  `data: elements <div hidden data-init="${expression}"></div>\n\n`

/** SSE comment line; keeps proxies from closing an idle stream. */
export const heartbeat = ': heartbeat\n\n'
