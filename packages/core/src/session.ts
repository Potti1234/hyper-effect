import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect'
import { renderToString } from 'foldkit/experimental/server'
import type { Html, HtmlBuilder } from 'foldkit/html'
import type * as Update from 'foldkit/update'

import { type Binder, type Handler, INPUT_HANDLER_ATTRIBUTE, inputSignal } from './binding'
import { assertNoDroppedHandlers, renderWith, withDiscardedRender } from './builder'
import { type ClientAction, type ClientCommands, foldkitUiCommands, isWithReplies } from './client-commands'
import { installFileReader } from './file-reader'
import * as Intake from './intake'
import { serializeHtml } from './foldkit-internal'
import { recordRegion, recordRender } from './metrics'
import type { Program } from './program'
import { sameDeps } from './deps'
import { type RegionHost, type RenderedRegion, fillRegions, withRegions } from './region'
import { collectShared, fillShared } from './shared'

// Commands of server sessions read uploaded files with Foldkit's `File`
// helpers, which need a `FileReader`.
installFileReader()

export const ROOT_ID = 'hyper-root'
export const TITLE_ID = 'hyper-title'

/** How long, and for how many newer tables, a handler table stays valid
 *  once its markup has been replaced. Each table keeps its render's view
 *  scope alive. A table whose markup is still on the page never expires. */
const HANDLER_RETENTION_MILLIS = 30_000
const HANDLER_RETENTION_COUNT = 64

/** Fields every event carries: `q` is the page's event sequence number; `p`
 *  holds input values the page had not sent yet (handler id → value), applied
 *  just before the event. */
const Envelope = {
  q: Schema.optional(Schema.Number),
  p: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}

/** What the browser posts for an event. `m` carries an encoded Message; `h`
 *  names a handler from the session's handler table. */
export const EventPayload = Schema.Union([
  Schema.Struct({ m: Schema.String, ...Envelope }),
  Schema.Struct({ h: Schema.String, v: Schema.String, ...Envelope }),
  Schema.Struct({ h: Schema.String, n: Schema.Number, ...Envelope }),
  Schema.Struct({
    h: Schema.String,
    k: Schema.String,
    s: Schema.Boolean,
    c: Schema.Boolean,
    a: Schema.Boolean,
    mt: Schema.Boolean,
    ...Envelope,
  }),
  Schema.Struct({ h: Schema.String, d: Schema.Unknown, ...Envelope }),
  Schema.Struct({ h: Schema.String, x: Schema.Array(Schema.Unknown), ...Envelope }),
  // A constant-Message handler needs no event data.
  Schema.Struct({ h: Schema.String, ...Envelope }),
  // The outcome of a forwarded Command with replies (`client-commands.ts`).
  Schema.Struct({ r: Schema.String, o: Schema.Literals(['ok', 'failed']), ...Envelope }),
])
export type EventPayload = typeof EventPayload.Type

/** An upload: files for a `Files` handler. Built by the upload route from a
 *  multipart body, never decoded from JSON. */
export type UploadPayload = Readonly<{
  h: string
  files: ReadonlyArray<File>
  q?: number | undefined
  p?: Readonly<Record<string, string>> | undefined
}>

/** Anything a page sends to its session. */
export type Payload = EventPayload | UploadPayload

export type Rendered = Readonly<{
  title: string
  /** The whole root, regions filled in. */
  html: string
  /** The root with a placeholder per region: the part of the page outside
   *  regions. While it is unchanged, only changed regions need sending. */
  frame: string
  /** The regions this render placed, with the version of their markup. */
  regions: ReadonlyMap<string, RenderedRegion>
  /** Signal patches for client-owned inputs the Model changed. */
  signals: Readonly<Record<string, string>>
  /** Browser effects of forwarded Commands, to run after this morph. */
  actions: ReadonlyArray<ClientAction>
  /** The intake position of the rendered Model (the next sequence number it
   *  expects), so the page knows which of its local effects it reflects. */
  position: number | undefined
}>

/** A Command as the runtime sees it: a named Effect that yields a Message. */
type RunnableCommand<Message, R> = Readonly<{
  name: string
  args?: Readonly<Record<string, unknown>>
  effect: Effect.Effect<Message, never, R>
  /** Recorded by `Command.mapMessage`: lifts the Command's own result
   *  Message into the program's (innermost first). */
  messageMappers?: ReadonlyArray<(message: unknown) => unknown>
}>

/** Replies offered for forwarded Commands, kept for this many newer ones. */
const MAX_REPLIES = 256

export interface Session<Model, Message> {
  readonly id: string
  readonly model: SubscriptionRef.SubscriptionRef<Model>
  readonly dispatch: (message: Message) => Effect.Effect<void>
  /** Renders the current Model. Each render replaces the handler table. */
  readonly render: Effect.Effect<Rendered, unknown>
  /** Turns a payload into a Message, without ordering. */
  readonly resolve: (payload: Payload) => Option.Option<Message>
  /** Applies a posted event in sequence order. Completes once the event is
   *  applied, or dropped as a repeat of one that is: an event held behind a
   *  gap completes when the gap closes. */
  readonly receive: (payload: Payload) => Effect.Effect<void>
  /** The applied Model with its position (the next sequence number the
   *  session expects) and the skipped numbers whose late events it would
   *  still apply, for snapshots: a restored session continues from them. The
   *  three always belong together. */
  readonly applied: () => Applied<Model>
  /** Calls `listener` with the new Model right after every update, in the
   *  update loop: cheaper than a stream of Model changes for checks that
   *  rarely fire. */
  readonly onUpdate: (listener: (model: Model) => void) => void
  /** Sizes of what a session keeps between renders, for metrics: both must
   *  stay bounded however long the session lives. */
  readonly retained: () => Readonly<{ handlerTables: number; regions: number }>
  readonly close: Effect.Effect<void>
}

export type Applied<Model> = Readonly<{
  model: Model
  position: number | undefined
  skipped: ReadonlyArray<number>
}>

export type Start<Model, Message, R> = Readonly<{
  model: Model
  commands?: Update.Return<Model, Message, R>['commands']
  /** Sequence number of the first event to expect. A fresh page starts at
   *  1; a restored session learns it from the first event it sees. */
  firstSequence?: number
  /** Skipped sequence numbers of a restored session. */
  skipped?: ReadonlyArray<number>
}>

/** Commands written for a browser runtime (focus, measuring, animation
 *  frames) fail on the server with a ReferenceError. That is expected for
 *  Submodels rendered server-side, so it is reported once per Command as a
 *  warning instead of an error each time. */
const BROWSER_GLOBAL =
  /\b(window|document|navigator|requestAnimationFrame|localStorage|sessionStorage|HTMLElement|matchMedia)\b/
const reportedBrowserOnly = new Set<string>()

const reportCommandFailure = (name: string, cause: Cause.Cause<unknown>) => {
  // The ReferenceError can arrive wrapped; look at the whole rendered cause.
  const text = Cause.pretty(cause)
  if (text.includes('ReferenceError') && BROWSER_GLOBAL.test(text)) {
    if (reportedBrowserOnly.has(name)) return Effect.void
    reportedBrowserOnly.add(name)
    return Effect.logWarning(
      `Command ${name} needs a browser (${text.split('\n')[0]}); skipped on the server. Use an island if it matters.`,
    )
  }
  return Effect.logError(`Command ${name} failed`, cause)
}

export const endpointFor = (programName: string, sessionId: string): string =>
  `/_hyper/${programName}/s/${sessionId}`

const encodeToken = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')

const decodeToken = (token: string): unknown =>
  JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))

/** Validate markup with Foldkit's full `renderToString` (a parse5 re-parse of
 *  every render) outside production. In production the vnode tree is
 *  serialized directly, about 3–10× faster; Foldkit's serializer still
 *  escapes text and attributes and validates names. */
export const VALIDATE_MARKUP = process.env['NODE_ENV'] !== 'production'

/** Foldkit records where every Submodel was rendered from (`new Error()`
 *  per Submodel per render), for its development tools. On a server that
 *  renders every page on every change this costs about 7% of the busy time,
 *  so in production views run without stack capture. `HYPER_VIEW_STACKS=1`
 *  keeps it, to debug a production render. */
const CAPTURE_VIEW_STACKS = VALIDATE_MARKUP || process.env['HYPER_VIEW_STACKS'] === '1'

const withoutStackCapture = <A>(render: () => A): A => {
  if (CAPTURE_VIEW_STACKS) return render()
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = 0
  try {
    return render()
  } finally {
    Error.stackTraceLimit = limit
  }
}

/** Outside production, unchanged regions are rendered anyway and compared
 *  with their cached markup, to catch incomplete deps. */
const CHECK_REGION_DEPS = VALIDATE_MARKUP

/** Whether two renders of a region are the same markup, handler ids aside.
 *  Most regions bind no handlers at all, so plain equality settles it. */
const sameMarkup = (a: string, b: string): boolean =>
  a === b || withoutHandlerIds(a) === withoutHandlerIds(b)

const withoutHandlerIds = (html: string): string =>
  html
    .replace(/h: '[^']*'/g, "h: ''")
    .replace(new RegExp(`${INPUT_HANDLER_ATTRIBUTE}="[^"]*"`, 'g'), `${INPUT_HANDLER_ATTRIBUTE}=""`)

/** Renders `model` through the server builder and returns the root markup. */
export const renderModel = <Model, Message, ClientMessage extends Message, Flags, R>(
  program: Program<Model, Message, ClientMessage, Flags, R>,
  model: Model,
  binder: Binder<Message>,
  options: Readonly<{ validate?: boolean; regions?: RegionHost }> = {},
): Effect.Effect<Readonly<{ title: string; html: string }>, unknown> =>
  Effect.suspend(() => {
    const startedAt = performance.now()
    // Shared markup placed by the view, spliced in after serialization.
    let sharedSlots: ReadonlyMap<string, string> = new Map()
    const buildRoot = (current: Model, base: HtmlBuilder<Message>) => {
      const { result, slots } = collectShared(() =>
        withRegions(options.regions, () =>
          renderWith(base, binder, h => {
            const document = withoutStackCapture(() => program.view(current, h))
            const root: Html = h.div([h.Id(ROOT_ID)], [document.body])
            assertNoDroppedHandlers(root)
            return { document, root }
          }),
        ),
      )
      sharedSlots = slots
      return result
    }

    if (options.validate ?? VALIDATE_MARKUP) {
      return renderToString<Model, Message>(
        {
          init: () => ({ model }),
          view: (current, base) => {
            const { document, root } = buildRoot(current, base)
            return { ...document, body: root }
          },
        },
        { isHydratable: false },
      ).pipe(
        Effect.map(({ html, title }) => ({ html: fillShared(html, sharedSlots), title })),
        Effect.tap(() => Effect.sync(() => recordRender(performance.now() - startedAt))),
      )
    }

    // Foldkit's render frame is still needed (Submodels, ChildAttributes), so
    // the tree is built inside renderToString; only a stub is validated.
    let rendered: Readonly<{ title: string; html: string }> | undefined
    return renderToString<Model, Message>(
      {
        init: () => ({ model }),
        view: (current, base) => {
          const { document, root } = buildRoot(current, base)
          rendered = { title: document.title, html: fillShared(serializeHtml(root), sharedSlots) }
          return { title: document.title, body: null }
        },
      },
      { isHydratable: false },
    ).pipe(
      Effect.flatMap(() =>
        rendered === undefined
          ? Effect.die(new Error('hyper-effect: the view did not render'))
          : Effect.succeed(rendered),
      ),
      Effect.tap(() => Effect.sync(() => recordRender(performance.now() - startedAt))),
    )
  })

export const make = <Model, Message, ClientMessage extends Message, Flags, R>(
  program: Program<Model, Message, ClientMessage, Flags, R>,
  id: string,
  start: Start<Model, Message, R>,
): Effect.Effect<Session<Model, Message>, never, R> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const model = yield* SubscriptionRef.make(start.model)
    /** A queued Message; `inputId` marks a value typed into a client-owned
     *  input, so renders know the browser is ahead until it is applied. */
    type Envelope = Readonly<{ message: Message; inputId?: string }>
    /** What the update loop takes at once: one dispatched Message, or the
     *  Messages of one event (its unsent input values, then the event
     *  itself) with the position after it. */
    type Batch = Readonly<{
      envelopes: ReadonlyArray<Envelope>
      position?: number | undefined
      skipped?: ReadonlySet<number> | undefined
      sequence?: number | undefined
      done?: Deferred.Deferred<void> | undefined
    }>
    const messages = yield* Queue.unbounded<Batch>()
    const clientMessageJson = Schema.toCodecJson(program.ClientMessage)
    const encodeClientMessage = Schema.encodeUnknownSync(clientMessageJson)
    const decodeClientMessage = Schema.decodeUnknownOption(clientMessageJson)
    const isClientMessage = Schema.is(program.ClientMessage)

    // Per client-owned input: received values not yet folded into the Model.
    const unappliedInputs = new Map<string, number>()

    const dispatch = (message: Message) =>
      Queue.offer(messages, { envelopes: [{ message }] }).pipe(Effect.asVoid)

    // Events received but not applied yet, so a repeat can wait for its
    // original, and a closing session can answer them.
    const pendingEvents = new Map<number, Deferred.Deferred<void>>()
    const pendingUnnumbered = new Set<Deferred.Deferred<void>>()

    // Browser effects of forwarded Commands, sent with the next render.
    const clientCommands: ClientCommands = { ...foldkitUiCommands, ...program.clientCommands }
    let pendingActions: Array<ClientAction> = []
    // Reply id → the lifted result Message per outcome.
    const replies = new Map<string, Readonly<{ ok: Message; failed: Message | undefined }>>()
    let replyCount = 0

    const runCommand = (command: RunnableCommand<Message, R>) => {
      const forward = clientCommands[command.name]?.(command.args ?? {})
      if (forward !== undefined) {
        if (!isWithReplies(forward)) {
          pendingActions.push(forward)
          return Effect.void
        }
        const lift = (message: unknown) =>
          /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
          (command.messageMappers ?? []).reduce((current, toParent) => toParent(current), message) as Message
        const replyId = `r${String((replyCount += 1))}`
        replies.set(replyId, {
          ok: lift(forward.replies.ok),
          failed: forward.replies.failed === undefined ? undefined : lift(forward.replies.failed),
        })
        if (replies.size > MAX_REPLIES) replies.delete(replies.keys().next().value as string)
        pendingActions.push({ ...forward.action, reply: replyId })
        return Effect.void
      }
      return command.effect.pipe(
        Effect.flatMap(dispatch),
        Effect.catchCause(cause => reportCommandFailure(command.name, cause)),
        Effect.forkIn(scope),
      )
    }

    const runCommands = (commands: Update.Return<Model, Message, R>['commands']) =>
      Effect.forEach(
        /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
        (commands ?? []) as ReadonlyArray<RunnableCommand<Message, R>>,
        runCommand,
        { discard: true },
      )

    // Subscriptions restart whenever their dependencies change, as in Foldkit.
    // The update loop checks them after every update: a Subscription watching
    // every Model change on its own stream costs a fiber wake-up per change,
    // and with many sessions those dominate.
    const subscriptionList = Object.values(program.subscriptions ?? {})
    type Running = {
      readonly subscription: (typeof subscriptionList)[number]
      readonly equivalence: (a: unknown, b: unknown) => boolean
      dependencies: unknown
      fiber: Fiber.Fiber<void> | undefined
    }
    const startSubscription = (entry: Running) =>
      Effect.gen(function* () {
        const dependencies = entry.dependencies
        entry.fiber = yield* entry.subscription
          .dependenciesToStream(dependencies as never, () => dependencies as never)
          .pipe(Stream.runForEach(dispatch), Effect.forkIn(scope))
      })
    const running: Array<Running> = []
    for (const subscription of subscriptionList) {
      const entry: Running = {
        subscription,
        equivalence: Schema.toEquivalence(subscription.dependenciesSchema) as (a: unknown, b: unknown) => boolean,
        dependencies: subscription.modelToDependencies(start.model),
        fiber: undefined,
      }
      running.push(entry)
      yield* startSubscription(entry)
    }
    const checkSubscriptions = (current: Model) =>
      Effect.gen(function* () {
        for (const entry of running) {
          const dependencies = entry.subscription.modelToDependencies(current)
          if (entry.equivalence(entry.dependencies, dependencies)) continue
          entry.dependencies = dependencies
          if (entry.fiber !== undefined) yield* Fiber.interrupt(entry.fiber)
          yield* startSubscription(entry)
        }
      })

    const updateListeners: Array<(model: Model) => void> = []

    // The applied Model, its position and the skipped numbers change
    // together, in one step: a snapshot must never hold an event's effect
    // while still expecting the event (a retry would apply it again), nor
    // the reverse (it would be lost).
    let applied: Applied<Model> = {
      model: start.model,
      position: start.firstSequence,
      skipped: start.skipped ?? [],
    }

    // The update loop: one batch at a time, so update stays a pure fold.
    yield* Effect.gen(function* () {
      const batch = yield* Queue.take(messages)
      const previous = applied.model
      let current = previous
      let typed = false
      const commands: Array<unknown> = []
      for (const { message, inputId } of batch.envelopes) {
        const next = program.update(current, message)
        current = next.model
        if (inputId !== undefined) {
          typed = true
          unappliedInputs.set(inputId, (unappliedInputs.get(inputId) ?? 1) - 1)
        }
        if (next.commands !== undefined) commands.push(...next.commands)
      }
      applied = {
        model: current,
        position: batch.position ?? applied.position,
        skipped: batch.skipped === undefined ? applied.skipped : [...batch.skipped],
      }
      if (batch.done !== undefined) {
        if (batch.sequence === undefined) pendingUnnumbered.delete(batch.done)
        else pendingEvents.delete(batch.sequence)
        Deferred.doneUnsafe(batch.done, Effect.void)
      }
      if (running.length > 0) yield* checkSubscriptions(current)
      for (const listener of updateListeners) listener(current)
      /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
      yield* runCommands(commands as Update.Return<Model, Message, R>['commands'])
      // Publishing the Model renders every connection of the session. A
      // Message that leaves the Model as it was (one that only starts a
      // Command) needs no render, unless a typed value was applied (the input
      // may need patching back to the Model) or a forwarded browser action
      // waits for the next render.
      if (current !== previous || typed || pendingActions.length > 0) {
        yield* SubscriptionRef.set(model, current)
      }
    }).pipe(Effect.forever, Effect.forkIn(scope))

    yield* runCommands(start.commands)

    // Handler tables, one per frame render and one per region render. A live
    // page renders often (store changes, presence, ticks), and an event can be
    // in flight across several morphs; it must still mean what the user saw
    // when they acted. Views are pure, so an older table is still correct for
    // its markup. A table is kept while its markup is on the page, and for a
    // while after it was replaced.
    type Table = { readonly table: Map<string, Handler<Message>>; replacedAt: number | undefined }
    const tables = new Map<string, Table>()
    const replace = (prefix: string, now: number) => {
      const entry = tables.get(prefix)
      if (entry !== undefined) entry.replacedAt = now
    }
    const forgetOldTables = (now: number) => {
      let replaced = 0
      for (const { replacedAt } of tables.values()) if (replacedAt !== undefined) replaced += 1
      // Maps iterate oldest first.
      for (const [prefix, { replacedAt }] of tables) {
        if (replacedAt === undefined) continue
        if (now - replacedAt > HANDLER_RETENTION_MILLIS || replaced > HANDLER_RETENTION_COUNT) {
          tables.delete(prefix)
          replaced -= 1
        }
      }
    }

    // What each client-owned input shows in the browser, as far as the server
    // knows: the value it rendered or the value the client last sent.
    const inputValues = new Map<string, string>()

    /** Where the render in progress registers handlers and inputs: the
     *  frame's table, or the table of the region being rendered. */
    type Sink = Readonly<{
      prefix: string
      table: Map<string, Handler<Message>>
      inputs: Map<string, string>
    }>
    let sink: Sink | undefined

    // Regions this session rendered. `html` is the region's own markup, with
    // a placeholder for each nested region; `version` changes only when that
    // markup does.
    type Region = Readonly<{
      deps: ReadonlyArray<unknown>
      html: string
      version: number
      prefix: string
      inputs: ReadonlyMap<string, string>
      children: ReadonlyArray<string>
    }>
    const regions = new Map<string, Region>()
    let regionVersion = 0
    let generation = 0
    let frameTable: string | undefined

    /** Renders a region whose deps are unchanged anyway and compares: other
     *  markup under the same deps means the deps miss an input, and the region
     *  would show stale content. Nested regions must then be unchanged as well,
     *  since an unchanged region keeps its nested ones without rendering them.
     *  Handler ids differ per render and are ignored. */
    const checkRegionDeps = (regionId: string, cached: Region, build: () => string) => {
      const checkNested: RegionHost = {
        scope: program.name,
        place: (nestedId, deps, nestedBuild) => {
          const nested = regions.get(nestedId)
          if (nested === undefined || !sameDeps(nested.deps, deps)) {
            throw new Error(
              `hyper-effect: region "${regionId}" keeps its deps while its nested region "${nestedId}" changes. Add the fields "${nestedId}" reads to the deps of "${regionId}".`,
            )
          }
          checkRegionDeps(nestedId, nested, nestedBuild)
        },
      }
      const outer = sink
      sink = { prefix: 'check', table: new Map(), inputs: new Map() }
      let again: string
      try {
        again = withRegions(checkNested, build)
      } finally {
        sink = outer
      }
      if (withoutHandlerIds(again) !== withoutHandlerIds(cached.html)) {
        throw new Error(
          `hyper-effect: region "${regionId}" renders differently with the same deps. Add every Model field its view reads to its deps.`,
        )
      }
    }

    const registerHandler = (handler: Handler<Message>) => {
      if (sink === undefined) {
        throw new Error('hyper-effect: a handler was bound outside a render.')
      }
      const handlerId = `${sink.prefix}.${sink.table.size.toString(36)}`
      sink.table.set(handlerId, handler)
      return handlerId
    }

    const binder: Binder<Message> = {
      endpoint: endpointFor(program.name, id),
      bindMessage: message => {
        if (!isClientMessage(message)) {
          throw new Error(
            'hyper-effect: a view bound a Message that is not a ClientMessage: ' +
              JSON.stringify(message),
          )
        }
        try {
          return `m: '${encodeToken(encodeClientMessage(message))}'`
        } catch {
          // A ClientMessage that is not JSON-encodable (an Option, a Date
          // without a codec): bind it as a session handler instead.
          return `h: '${registerHandler({ _tag: 'Message', message })}'`
        }
      },
      registerHandler,
      registerInput: (inputId, value) => {
        sink?.inputs.set(inputId, value)
      },
    }

    const render = Effect.suspend(() => {
      generation += 1
      const prefix = generation.toString(36)
      const frame: Sink = { prefix, table: new Map(), inputs: new Map() }
      // Every client-owned input on the page, frame and regions, with the
      // value the Model holds for it.
      const inputs = new Map<string, string>()
      // The regions on the page after this render, with their parent region.
      const placed = new Map<string, Region>()
      const parents = new Map<string, string | undefined>()
      // The regions being rendered, innermost last, and what they nest.
      const building: Array<{ readonly id: string; readonly children: Array<string> }> = []
      const replacedPrefixes: Array<string> = []
      let regionIndex = 0

      /** Puts a region and, recursively, the regions it nests on the page as
       *  they are: its deps are unchanged, so is all of it. */
      const keep = (regionId: string, parent: string | undefined) => {
        const region = regions.get(regionId)
        if (region === undefined) return
        placed.set(regionId, region)
        parents.set(regionId, parent)
        for (const [inputId, value] of region.inputs) inputs.set(inputId, value)
        for (const child of region.children) keep(child, regionId)
      }

      const regionHost: RegionHost = {
        scope: program.name,
        place: (regionId, deps, build) => {
          if (placed.has(regionId)) {
            throw new Error(`hyper-effect: region "${regionId}" is placed twice in one render.`)
          }
          const parent = building[building.length - 1]
          parent?.children.push(regionId)
          const cached = regions.get(regionId)
          if (cached !== undefined && sameDeps(cached.deps, deps)) {
            if (CHECK_REGION_DEPS) checkRegionDeps(regionId, cached, build)
            recordRegion('kept')
            keep(regionId, parent?.id)
            return
          }
          const own: Sink = {
            prefix: `${prefix}-${(regionIndex += 1).toString(36)}`,
            table: new Map(),
            inputs: new Map(),
          }
          const children: Array<string> = []
          const outer = sink
          sink = own
          building.push({ id: regionId, children })
          let html: string
          try {
            html = build()
          } finally {
            building.pop()
            sink = outer
          }
          let next: Region
          if (cached !== undefined && sameMarkup(html, cached.html)) {
            // The same markup: the page keeps it, and its handler ids now name
            // this render's handlers (registered in the same order).
            recordRegion('unchanged')
            const renamed = new Map<string, Handler<Message>>()
            for (const [handlerId, handler] of own.table) {
              renamed.set(cached.prefix + handlerId.slice(own.prefix.length), handler)
            }
            tables.set(cached.prefix, { table: renamed, replacedAt: undefined })
            next = { ...cached, deps, inputs: own.inputs, children }
          } else {
            recordRegion('rendered')
            if (cached !== undefined) replacedPrefixes.push(cached.prefix)
            tables.set(own.prefix, { table: own.table, replacedAt: undefined })
            next = {
              deps,
              html,
              version: (regionVersion += 1),
              prefix: own.prefix,
              inputs: own.inputs,
              children,
            }
          }
          regions.set(regionId, next)
          placed.set(regionId, next)
          parents.set(regionId, parent?.id)
          for (const [inputId, value] of own.inputs) inputs.set(inputId, value)
        },
      }

      return Effect.sync(() => applied).pipe(
        // Taken together with the Model: which inputs the browser is ahead
        // on, and the intake position the Model reflects.
        Effect.map(({ model: current, position }) => ({
          current,
          position,
          unapplied: new Map(unappliedInputs),
        })),
        Effect.flatMap(({ current, position, unapplied }) =>
          Effect.suspend(() => {
            sink = frame
            return renderModel(program, current, binder, { regions: regionHost })
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                sink = undefined
              }),
            ),
            Effect.map(rendered => ({ rendered, position, unapplied })),
          ),
        ),
        Effect.map(({ rendered, position, unapplied }): Rendered => {
          const now = Date.now()
          tables.set(prefix, { table: frame.table, replacedAt: undefined })
          if (frameTable !== undefined) replace(frameTable, now)
          frameTable = prefix
          for (const replaced of replacedPrefixes) replace(replaced, now)
          // Regions the view no longer places are gone from the page.
          for (const [regionId, region] of regions) {
            if (!placed.has(regionId)) {
              regions.delete(regionId)
              replace(region.prefix, now)
            }
          }
          forgetOldTables(now)
          for (const [inputId, value] of frame.inputs) inputs.set(inputId, value)
          // Patch an input only where the Model diverges from the browser, and
          // never while the browser is ahead: a Model that has not applied the
          // latest typed value would otherwise overwrite newer keystrokes.
          const signals: Record<string, string> = {}
          for (const [inputId, value] of inputs) {
            if ((unapplied.get(inputId) ?? 0) > 0) continue
            const shown = inputValues.get(inputId)
            if (shown !== undefined && shown !== value) {
              signals[inputSignal(inputId).name] = value
            }
            inputValues.set(inputId, value)
          }
          const actions = pendingActions
          pendingActions = []

          // Markup with nested regions filled in, built only when a patch or
          // the page needs it.
          const filled = new Map<string, string>()
          const filledRegion = (regionId: string): string | undefined => {
            const region = placed.get(regionId)
            if (region === undefined) return undefined
            let html = filled.get(regionId)
            if (html === undefined) {
              html = region.children.length === 0 ? region.html : fillRegions(region.html, filledRegion)
              filled.set(regionId, html)
            }
            return html
          }
          let page: string | undefined
          const renderedRegions = new Map<string, RenderedRegion>()
          for (const [regionId, region] of placed) {
            renderedRegions.set(regionId, {
              version: region.version,
              parent: parents.get(regionId),
              get html() {
                return filledRegion(regionId) ?? ''
              },
            })
          }
          return {
            title: rendered.title,
            get html() {
              return (page ??= fillRegions(rendered.html, filledRegion))
            },
            frame: rendered.html,
            regions: renderedRegions,
            signals,
            actions,
            position,
          }
        }),
      )
    })

    /** Turns a payload into an envelope. Pure: no session state changes.
     *  Handlers run in a discarded render frame: some call view code. */
    const resolveEvent = (payload: Payload): Option.Option<Envelope> =>
      withDiscardedRender(() => resolveEventNow(payload))

    const resolveEventNow = (payload: Payload): Option.Option<Envelope> => {
      if ('r' in payload) {
        const reply = replies.get(payload.r)
        const message = reply === undefined ? undefined : payload.o === 'ok' ? reply.ok : reply.failed
        return message === undefined ? Option.none() : Option.some({ message })
      }
      if ('m' in payload) {
        try {
          return Option.map(decodeClientMessage(decodeToken(payload.m)), message => ({ message }))
        } catch {
          return Option.none()
        }
      }
      const prefix = payload.h.slice(0, payload.h.indexOf('.'))
      const handler = tables.get(prefix)?.table.get(payload.h)
      if (handler === undefined) {
        return Option.none()
      }
      const plain = (message: Option.Option<Message>) => Option.map(message, value => ({ message: value }))
      switch (handler._tag) {
        case 'Value':
          if (!('v' in payload)) return Option.none()
          return Option.some(
            handler.inputId === undefined
              ? { message: handler.f(payload.v) }
              : { message: handler.f(payload.v), inputId: handler.inputId },
          )
        case 'Number':
          return 'n' in payload ? Option.some({ message: handler.f(payload.n) }) : Option.none()
        case 'Key':
          return 'k' in payload
            ? plain(
                handler.f(payload.k, {
                  shiftKey: payload.s,
                  ctrlKey: payload.c,
                  altKey: payload.a,
                  metaKey: payload.mt,
                }),
              )
            : Option.none()
        case 'Custom':
          return 'd' in payload
            ? plain(handler.f(new CustomEvent(handler.name, { detail: payload.d })))
            : Option.none()
        case 'Args':
          return 'x' in payload ? plain(handler.f(payload.x)) : Option.none()
        case 'Message':
          return Option.some({ message: handler.message })
        case 'Files':
          return 'files' in payload ? Option.some({ message: handler.f(payload.files) }) : Option.none()
      }
    }

    const resolve = (payload: Payload): Option.Option<Message> =>
      Option.map(resolveEvent(payload), envelope => envelope.message)

    /** The event's envelopes: first the unsent input values it carries, then
     *  the event itself. Typed values are noted as the browser's latest, and as
     *  not applied yet, at once: renders until then must not patch them. */
    const resolveAll = (payload: Payload): ReadonlyArray<Option.Option<Envelope>> => {
      const pairs: ReadonlyArray<readonly [Option.Option<Envelope>, string | undefined]> = [
        ...Object.entries(payload.p ?? {})
          .filter(([handlerId]) => !('h' in payload) || handlerId !== payload.h)
          .map(([h, v]) => [resolveEvent({ h, v }), v] as const),
        [resolveEvent(payload), 'v' in payload ? payload.v : undefined],
      ]
      return pairs.map(([envelope, value]) => {
        if (Option.isSome(envelope) && envelope.value.inputId !== undefined && value !== undefined) {
          const inputId = envelope.value.inputId
          inputValues.set(inputId, value)
          unappliedInputs.set(inputId, (unappliedInputs.get(inputId) ?? 0) + 1)
        }
        return envelope
      })
    }

    // Ordered intake (intake.ts): events are applied in sequence order and
    // at most once; a gap that outlives the timeout is skipped, and its late
    // event is still applied once. The deadline runs on a timer.
    type Item = Readonly<{ envelopes: ReadonlyArray<Envelope>; done: Deferred.Deferred<void> }>
    let intake = Intake.make<Item>(start.firstSequence, start.skipped)
    let timer: Fiber.Fiber<void> | undefined
    let timerDeadline: number | undefined

    /** Takes a step at once, and hands its events to the update loop all
     *  together, so concurrent posts cannot interleave their Messages. The
     *  returned Effect only logs and rearms the timer. */
    const apply = (step: Intake.Step<Item>): Effect.Effect<void> => {
      intake = step.intake
      Queue.offerAllUnsafe(
        messages,
        step.delivered.map(({ sequence, item, late }) => ({
          envelopes: item.envelopes,
          // A late event fills an old gap; the position stays.
          position: sequence === undefined || late ? undefined : sequence + 1,
          // As of the whole step: numbers it skipped lie before its first
          // event, and a late event is a step of its own.
          skipped: step.intake.skipped,
          sequence,
          done: item.done,
        })),
      )
      return step.skippedNow.length === 0
        ? armTimer
        : Effect.logWarning(
            `Skipping lost events ${step.skippedNow[0]}..${step.skippedNow[step.skippedNow.length - 1]}`,
          ).pipe(Effect.andThen(armTimer))
    }

    const onDeadline: Effect.Effect<void> = Effect.suspend(() => {
      timer = undefined
      timerDeadline = undefined
      return apply(Intake.expire(intake, Date.now()))
    })

    /** Keeps one timer, for the intake's current deadline. */
    const armTimer: Effect.Effect<void> = Effect.suspend(() => {
      const due = Intake.deadline(intake)
      if (due === timerDeadline) return Effect.void
      const previous = timer
      timer = undefined
      timerDeadline = due
      return Effect.gen(function* () {
        if (previous !== undefined) yield* Fiber.interrupt(previous)
        if (due !== undefined) {
          timer = yield* onDeadline.pipe(
            Effect.delay(Duration.millis(Math.max(0, due - Date.now()))),
            Effect.forkIn(scope),
          )
        }
      })
    })

    // From the repeat check to the intake step nothing yields: two copies of
    // one event arriving together must not both count as new.
    const receive = (payload: Payload): Effect.Effect<void> =>
      Effect.suspend(() => {
        const sequence = payload.q
        // A repeat (a retried request) changes nothing, not even the record
        // of which typed values are on their way. It completes with its
        // original, which may still wait behind a gap.
        if (Intake.isRepeat(intake, sequence)) {
          const original = sequence === undefined ? undefined : pendingEvents.get(sequence)
          return Effect.logDebug(`Dropped repeated event ${sequence}`).pipe(
            Effect.andThen(original === undefined ? Effect.void : Deferred.await(original)),
          )
        }
        const resolved = resolveAll(payload)
        const envelopes: Array<Envelope> = []
        for (const envelope of resolved) if (Option.isSome(envelope)) envelopes.push(envelope.value)
        const done = Deferred.makeUnsafe<void>()
        if (sequence === undefined) pendingUnnumbered.add(done)
        else pendingEvents.set(sequence, done)
        const applied = apply(Intake.receive(intake, sequence, { envelopes, done }, Date.now()))
        const unresolvable = Option.isNone(resolved[resolved.length - 1] ?? Option.none())
        return Effect.gen(function* () {
          if (unresolvable) yield* Effect.logWarning('Unresolvable event', payload)
          yield* applied
          yield* Deferred.await(done)
        })
      })

    return {
      id,
      model,
      dispatch,
      render,
      resolve,
      receive,
      applied: () => applied,
      onUpdate: listener => {
        updateListeners.push(listener)
      },
      retained: () => ({ handlerTables: tables.size, regions: regions.size }),
      // Events still waiting are answered: the session is gone either way.
      close: Scope.close(scope, Exit.void).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            for (const done of [...pendingEvents.values(), ...pendingUnnumbered]) {
              Deferred.doneUnsafe(done, Effect.void)
            }
          }),
        ),
      ),
    }
  })
