import { Context, Effect, Layer } from 'effect'
import { HttpRouter, HttpServer } from 'effect/http'
import { KeyValueStore } from 'effect/persistence'

import type { Program } from './program'
import * as Hyper from './server'

/* Helpers for driving `Hyper.layer` through a web handler, the way a browser
   would: a page GET sets the visitor cookie, and session requests carry it
   plus Datastar's request header. */

export const token = (value: unknown) =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')

export type Handler = (request: Request) => Promise<Response>

export const makeStore = () =>
  KeyValueStore.layerMemory.pipe(Layer.build, Effect.scoped, Effect.runSync)

/** Serves `served` as a web handler. `services` provides what the program
 *  needs (its `R`: stores, clients), such as the app's own layers or test
 *  doubles. */
export const serve = <M, Msg, C extends Msg, F, R = never>(
  served: Program<M, Msg, C, F, R>,
  options: Hyper.Options<R> = {},
  store = makeStore(),
  services: Layer.Layer<R> = Layer.empty as unknown as Layer.Layer<R>,
) =>
  HttpRouter.toWebHandler(
    Hyper.layer(served, options).pipe(
      Layer.provide(HttpServer.layerServices),
      Layer.provide(Layer.succeedContext(store)),
      Layer.provide(services),
    ),
  )

export type Page = Readonly<{
  response: Response
  html: string
  sessionId: string
  program: string
  cookie: string
}>

export const openPage = async (handler: Handler, path = '/', cookie?: string): Promise<Page> => {
  const response = await handler(
    new Request(`http://localhost${path}`, cookie === undefined ? {} : { headers: { cookie } }),
  )
  const html = await response.text()
  const match = html.match(/\/_hyper\/([a-z-]+)\/s\/([0-9a-z.-]+)\/stream/)
  const setCookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  return {
    response,
    html,
    program: match?.[1] ?? '',
    sessionId: match?.[2] ?? '',
    // The cookies passed in (an app's sign-in, a known visitor) plus the
    // visitor cookie a first visit gets.
    cookie: [cookie, setCookie].filter(part => part !== undefined && part !== '').join('; '),
  }
}

export const postEvent = (
  handler: Handler,
  page: Pick<Page, 'program' | 'sessionId' | 'cookie'>,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
) =>
  handler(
    new Request(`http://localhost/_hyper/${page.program}/s/${page.sessionId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'datastar-request': 'true',
        cookie: page.cookie,
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )

export const openStream = (
  handler: Handler,
  page: Pick<Page, 'program' | 'sessionId' | 'cookie'>,
  headers: Readonly<Record<string, string>> = {},
) =>
  handler(
    new Request(`http://localhost/_hyper/${page.program}/s/${page.sessionId}/stream?u=%2F`, {
      headers: { 'datastar-request': 'true', cookie: page.cookie, ...headers },
    }),
  )

export const readUntil = async (response: Response, needle: string): Promise<string> => {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  while (!text.includes(needle)) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  await reader.cancel()
  return text
}

/** Waits until the session's snapshot is in `store` (snapshots are written a
 *  quiet second after the last change). */
export const waitForSnapshot = async (
  store: Context.Context<KeyValueStore.KeyValueStore>,
  page: Pick<Page, 'program' | 'sessionId'>,
  timeoutMillis = 5000,
): Promise<void> => {
  const keyValues = Context.get(store, KeyValueStore.KeyValueStore)
  const key = `hyper/${page.program}/${page.sessionId}`
  const deadline = Date.now() + timeoutMillis
  while (Date.now() < deadline) {
    if ((await Effect.runPromise(keyValues.get(key))) !== undefined) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`No snapshot for ${key} after ${timeoutMillis} ms`)
}

/** Renders a Model the way a session does, for view tests. */
export { renderModel } from './session'
export type { Binder } from './binding'
