import { Data, type Effect, type Schema } from 'effect'
import type { Document, HtmlBuilder } from 'foldkit/html'
import type { Subscriptions } from 'foldkit/subscription'
import type { Return } from 'foldkit/update'

import type { ClientCommands } from './client-commands.ts'

/** The request a page is rendered for: the full URL, the path parameters
 *  matched by the program's path pattern, a stable id for the browser (an
 *  HttpOnly cookie hyper-effect sets on the first visit), and the request's
 *  cookies and headers, for authentication.
 *
 *  Flags also run when a session is recreated from its URL (after a restart,
 *  without a snapshot); `cookies` and `headers` are then those of the stream
 *  request that recreates it: same browser, same cookies, other headers. */
export type PageRequest = Readonly<{
  url: URL
  params: Readonly<Record<string, string>>
  visitorId: string
  cookies: Readonly<Record<string, string>>
  headers: Readonly<Record<string, string | undefined>>
}>

/** Fail Flags with this to answer the page with 404. */
export class PageNotFound extends Data.TaggedError('PageNotFound')<{}> {}

/** Fail Flags with this to send the browser elsewhere, such as to a login
 *  page. A page GET answers with a redirect (303 by default); a live page
 *  whose session is recreated navigates there. `location` is used as given:
 *  validate it if it carries user input (a `next` parameter, say). */
export class PageRedirect extends Data.TaggedError('PageRedirect')<{
  readonly location: string
  readonly status?: 302 | 303 | 307
}> {}

/** A Foldkit-shaped program whose loop runs on the server. Model, Message,
 *  update, view, Commands and Subscriptions keep their Foldkit meaning; the
 *  browser only renders morphs and posts events.
 *
 *  - `flags` is Foldkit's Flags made effectful and request-aware: load what
 *    the page needs (from the URL, the database, the user) before `init`.
 *  - `Model` lets the session be snapshotted, so a page survives a server
 *    restart or a move to another node with its UI state intact.
 *  - `ClientMessage` lists the Messages a browser may send directly. Anything
 *    outside it (Command results, Subscription events) cannot be forged by a
 *    client, and a view that binds such a Message to an event fails to render. */
export interface Program<
  Model,
  Message,
  ClientMessage extends Message,
  Flags = void,
  R = never,
> {
  /** Names the program's endpoints (`/_hyper/<name>/...`) and snapshots. */
  readonly name: string
  readonly Model: Schema.Codec<Model, unknown, never, never>
  readonly ClientMessage: Schema.Codec<ClientMessage, unknown, never, never>
  readonly flags: (
    request: PageRequest,
  ) => Effect.Effect<Flags, PageNotFound | PageRedirect, R>
  readonly init: (flags: Flags) => Return<Model, Message, R>
  readonly update: (model: Model, message: Message) => Return<Model, Message, R>
  readonly view: (model: Model, h: HtmlBuilder<Message>) => Document
  readonly subscriptions?: Subscriptions<Model, Message, R>
  /** Turns "the page's live connection opened / closed" into a Message, so
   *  the Model knows whether anyone is looking and Subscriptions can depend
   *  on it (presence, expensive feeds). A session outlives its connection by
   *  the idle timeout. */
  readonly onConnectionChange?: (isConnected: boolean) => Message
  /** Navigation within the session: the browser went to another URL that
   *  this program serves (a link, back/forward, a `load` Command), and this
   *  turns it into a Message instead of loading a new page. Like `flags` it
   *  may read the request and fail with PageNotFound or PageRedirect, which
   *  load the URL as a page. Without it every URL change is a page load. */
  readonly onUrlChange?: (
    request: PageRequest,
  ) => Effect.Effect<Message, PageNotFound | PageRedirect, R>
  /** Browser-only Commands to forward to the page instead of running them
   *  (see `client-commands.ts`); Foldkit UI's focus Commands are built in. */
  readonly clientCommands?: ClientCommands
  /** The parts of the Model that are this session's own (a selection, a
   *  filter, a draft), compared by value: a snapshot is written only when
   *  they change. Leave out what Flags or Subscriptions bring back after a
   *  restore anyway (shared data, presence): under load, rewriting every
   *  session's snapshot on every shared change costs about a tenth of the
   *  server's time. Without it, every change of the Model is snapshotted. */
  readonly snapshotDeps?: (model: Model) => ReadonlyArray<unknown>
}

export type AnyProgram = Program<any, any, any, any, any>

/** Matches `pathname` against a pattern such as `/incidents/:id`. */
export const matchPath = (
  pattern: string,
  pathname: string,
): Readonly<Record<string, string>> | undefined => {
  const patternParts = pattern.split('/').filter(part => part !== '')
  const pathParts = pathname.split('/').filter(part => part !== '')
  if (patternParts.length !== pathParts.length) {
    return undefined
  }
  const params: Record<string, string> = {}
  for (const [index, part] of patternParts.entries()) {
    const actual = pathParts[index] ?? ''
    if (part.startsWith(':')) {
      params[part.slice(1)] = decodeURIComponent(actual)
    } else if (part !== actual) {
      return undefined
    }
  }
  return params
}
