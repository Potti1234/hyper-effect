import { type ChildProcess, fork } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'
import { Context, Duration, Effect, Layer, Option, Schema as S, type Scope, Stream } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { KeyValueStore } from 'effect/persistence'

import { PageHost, type PageRoute, StylesheetChanges } from '@hyper-effect/core'

import { Badge, Contributions, NavEntry, SlotContent } from '../contributions.ts'
import { background } from '../graft.ts'
import { ExtensionData, SqlValueSchema } from '../data.ts'
import { ExtensionSettings, type SettingValue } from '../settings.ts'
import { type Handler, type Peer, decodeOrDie, make } from './bridge.ts'
import type { RemoteService } from './remote.ts'

/* An extension in a process of its own (see child.ts for the other side).

   Each version of an extension is bundled with esbuild (its files, the app
   modules and packages it imports, and the child runtime) into one file in
   a folder of its own, and started with Node's permission model: it may
   read that folder only, and has no network, no child processes, no
   workers and none of the server's environment variables besides those the
   app gives it. A new version is a new process; the old one is stopped
   after the swap, so its modules leave memory with it.

   The server side, a layer mounted like an in-process extension, serves
   the extension's process what it may use: the app's services as the app
   described them, the registry (whose entries the server keeps, so the
   app's pages see them), a key-value store limited to keys under
   `isolated/<id>/`, the stylesheet changes and member settings. It mounts
   the extension's pages on the page host as routes that forward each
   request, with the signed-in member in `x-jellyware-principal` (a header
   the server sets and the browser cannot), and drains them through the
   process when another version takes over.

   A watchdog asks the process every `heartbeat`; when no answer comes
   within `deadline` (a blocked event loop), or the process ends, it is
   stopped and the extension fails, as a failed build does. */

export type IsolationOptions = Readonly<{
  /** Where each version's bundle goes, in a folder of its own. */
  bundleDirectory: string
  /** The app's services an extension may use in its process, besides the
   *  page host, the registry and the key-value store ... */
  services: ReadonlyArray<RemoteService>
  /** ... and the module that exports them as `remoteServices`, which the
   *  bundle imports. */
  servicesModule: string
  /** The tsconfig for path aliases of the app's modules. */
  tsconfig?: string
  /** Who is signed in, for a request forwarded to an extension's page. */
  identify: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<string | undefined>
  /** Environment variables of an extension's process, besides the few Node
   *  needs; for example a snapshot secret derived for this extension. */
  environment?: (id: string) => Readonly<Record<string, string>>
  /** How often the watchdog asks the process; default one second. */
  heartbeat?: Duration.Input
  /** How long the process may take to answer; default five seconds. */
  deadline?: Duration.Input
}>

const CHILD_RUNTIME = fileURLToPath(new URL('./child.ts', import.meta.url))
const EXTENSION_API = fileURLToPath(new URL('../api.ts', import.meta.url))
/** What Node needs from the environment on every platform. */
const BASE_ENVIRONMENT = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR']

/** Foldkit's server serializer, which core finds at run time by path; the
 *  bundle imports it directly. */
const serializerPath = () =>
  (createRequire(import.meta.url).resolve.paths('foldkit') ?? [])
    .map(directory => join(directory, 'foldkit', 'dist', 'experimental', 'server', 'serialize.js'))
    .find(candidate => existsSync(candidate))

const slash = (path: string) => path.split('\\').join('/')

/** Bundles one version of an extension; fails with esbuild's message. */
const bundle = (entry: string, servicesModule: string, outfile: string, tsconfig: string | undefined) =>
  Effect.tryPromise({
    try: async () => {
      const serializer = serializerPath()
      await build({
        stdin: {
          contents: [
            `import extension from ${JSON.stringify(slash(entry))}`,
            `import { remoteServices } from ${JSON.stringify(slash(servicesModule))}`,
            `import { runChild } from ${JSON.stringify(slash(CHILD_RUNTIME))}`,
            'runChild(extension, remoteServices)',
          ].join('\n'),
          resolveDir: join(entry, '..'),
          sourcefile: 'extension-process.ts',
          loader: 'ts',
        },
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        outfile,
        ...(tsconfig === undefined ? {} : { tsconfig }),
        // Extensions import the registry and settings only, not the loader.
        alias: { '@hyper-effect/jellyware': EXTENSION_API },
        logLevel: 'silent',
        banner: {
          js: "import { createRequire as __jellywareRequire } from 'node:module'; const require = __jellywareRequire(import.meta.url); const __filename = import.meta.filename; const __dirname = import.meta.dirname;",
        },
        plugins: [
          {
            name: 'foldkit-serializer',
            setup: builder => {
              builder.onLoad({ filter: /foldkit-internal\.ts$/ }, () => ({
                contents:
                  serializer === undefined
                    ? "throw new Error('Foldkit server serializer not found')"
                    : `export { serializeHtml } from ${JSON.stringify(slash(serializer))}`,
                loader: 'js',
              }))
            },
          },
        ],
      })
    },
    catch: error =>
      `The extension could not be bundled: ${typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error)}`,
  })

const HttpHead = S.Struct({ status: S.Number, headers: S.Array(S.Tuple([S.String, S.String])), bodyId: S.NullOr(S.Number) })
const MountRequest = S.Struct({ mountId: S.Number, name: S.String, paths: S.Array(S.String) })
const Registration = S.Struct({ slot: S.String, id: S.String, key: S.String })
const CommandRegistration = S.Struct({ id: S.String, roles: S.NullOr(S.Array(S.String)) })
const SlotContext = S.Record(S.String, S.String)
const CommandInput = S.Struct({ args: S.Json, memberId: S.String })

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length'])

const isPath = (path: string): path is `/${string}` => path.startsWith('/')

// What the app's services answer with. Their members need nothing but the
// services the app built them with, as the app's own pages use them.
const isEffect = (value: unknown): value is Effect.Effect<unknown, unknown> => Effect.isEffect(value)
const isScoped = (value: unknown): value is Effect.Effect<unknown, unknown, Scope.Scope> => Effect.isEffect(value)
const isStream = (value: unknown): value is Stream.Stream<unknown, unknown> => Stream.isStream(value)

/** The routes on the server for a page the extension's process serves. */
const forwardingRoutes = (
  peer: Peer,
  mountId: number,
  name: string,
  paths: ReadonlyArray<string>,
  identify: IsolationOptions['identify'],
): ReadonlyArray<PageRoute> => {
  const forward = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const body = request.method === 'GET' || request.method === 'HEAD' ? null : new Uint8Array(yield* request.arrayBuffer)
    const principal = yield* identify(request)
    const headers = Object.entries(request.headers).filter(([header]) => !header.startsWith('x-jellyware-'))
    if (principal !== undefined) headers.push(['x-jellyware-principal', principal])
    const head = yield* peer.call('http.start', [{ mountId, method: request.method, url: request.url, headers, body }]).pipe(
      Effect.flatMap(decodeOrDie(HttpHead)),
    )
    const responseHeaders = new Headers()
    for (const [header, value] of head.headers) if (!HOP_BY_HOP.has(header)) responseHeaders.append(header, value)
    const bodyStream =
      head.bodyId === null
        ? null
        : Stream.toReadableStream(
            peer.stream('http.body', [head.bodyId]).pipe(
              Stream.map(chunk => (chunk instanceof Uint8Array ? chunk : new Uint8Array())),
              Stream.orDie,
            ),
          )
    return HttpServerResponse.fromWeb(new Response(bodyStream, { status: head.status, headers: responseHeaders }))
  }).pipe(
    Effect.catchCause(() => Effect.succeed(HttpServerResponse.text('The extension did not answer.', { status: 502 }))),
  )
  return [
    ...paths.filter(isPath).map(path => HttpRouter.route('GET', path, forward)),
    HttpRouter.route('*', `/_hyper/${name}/*`, forward),
  ]
}

/** A process's stdout and stderr, line by line, in the server's log. */
const relayOutput = (child: ChildProcess, id: string) => {
  for (const output of [child.stdout, child.stderr]) {
    let buffer = ''
    output?.on('data', chunk => {
      buffer += String(chunk)
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim() !== '') process.stderr.write(`[extension ${id}] ${line}\n`)
    })
  }
}

/** One version of an extension in a process of its own, as a layer to
 *  mount like the extension's own: it fails with what went wrong (the
 *  bundle, the build in the process), and later when the process ends or
 *  stops answering. */
export const isolatedExtension = (
  input: Readonly<{
    id: string
    /** The extension's entry module. */
    entry: string
    /** Its settings: values, and secrets in the clear. */
    values: Readonly<Record<string, SettingValue>>
    secrets: Readonly<Record<string, string>>
    options: IsolationOptions
  }>,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const { id, options } = input
      // Everything the extension may reach, looked up by key below.
      const context = yield* Effect.context<PageHost | Contributions | KeyValueStore.KeyValueStore | ExtensionSettings | ExtensionData>()
      const data = Context.get(context, ExtensionData)
      const pageHost = Context.get(context, PageHost)
      const contributions = Context.get(context, Contributions)
      const settings = Context.get(context, ExtensionSettings)
      const store = KeyValueStore.prefix(Context.get(context, KeyValueStore.KeyValueStore), `isolated/${id}/`)
      const styles = yield* StylesheetChanges

      // The bundle, in a folder of its own: all the process may read.
      const folder = join(options.bundleDirectory, id, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
      yield* Effect.acquireRelease(
        Effect.promise(() => mkdir(folder, { recursive: true })),
        () => Effect.promise(() => rm(folder, { recursive: true, force: true }).catch(() => undefined)),
      )
      const file = join(folder, 'extension.mjs')
      yield* bundle(input.entry, options.servicesModule, file, options.tsconfig)

      const environment: Record<string, string> = { JELLYWARE_ISOLATED: '1', NODE_ENV: process.env['NODE_ENV'] ?? 'development' }
      for (const key of BASE_ENVIRONMENT) {
        const value = process.env[key]
        if (value !== undefined) environment[key] = value
      }
      Object.assign(environment, options.environment?.(id) ?? {})

      const handlers = new Map<string, Handler>()
      const child = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const started = fork(file, [], {
            execArgv: ['--permission', `--allow-fs-read=${folder}`],
            env: environment,
            serialization: 'advanced',
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            windowsHide: true,
          })
          relayOutput(started, id)
          started.on('error', () => undefined)
          return started
        }),
        started => Effect.sync(() => started.kill()),
      )
      const peer = yield* make(
        {
          // A process that just ended answers a send with EPIPE; the exit
          // event closes the channel.
          send: message => {
            if (child.connected && typeof message === 'object' && message !== null) child.send(message, () => undefined)
          },
          onMessage: handler => child.on('message', handler),
          onClose: handler => child.on('exit', (code, signal) => handler(`the process ended (${signal ?? code ?? 'unknown'})`)),
        },
        handlers,
      )
      const serve = (name: string, handler: Handler) => handlers.set(name, handler)

      // The app's services, as described.
      for (const service of options.services) {
        const found = Context.getOption(context, service.key)
        if (Option.isNone(found)) continue
        const target = found.value
        for (const [member, kind] of Object.entries(service.members)) {
          const name = `${service.key.key}.${member}`
          const at = (): unknown => Reflect.get(Object(target), member)
          const invoke = (args: ReadonlyArray<unknown>): unknown => {
            const fn = at()
            return typeof fn === 'function' ? Reflect.apply(fn, target, args) : undefined
          }
          const missing = new Error(`${name} is not available.`)
          const asEffect = (value: unknown) => (isEffect(value) ? value : Effect.die(missing))
          const asScoped = (value: unknown) => (isScoped(value) ? value : Effect.die(missing))
          const asStream = (value: unknown) => (isStream(value) ? value : Stream.die(missing))
          switch (kind) {
            case 'value':
              serve(name, { kind: 'call', run: () => asEffect(at()) })
              break
            case 'stream':
              serve(name, { kind: 'stream', open: () => asStream(at()) })
              break
            case 'call':
              serve(name, { kind: 'call', run: args => asEffect(invoke(args)) })
              break
            case 'callStream':
              serve(name, { kind: 'stream', open: args => asStream(invoke(args)) })
              break
            case 'scoped':
              serve(name, { kind: 'scoped', acquire: args => asScoped(invoke(args)) })
              break
          }
        }
      }

      // The key-value store, under this extension's prefix.
      serve('kv.get', { kind: 'call', run: ([key]) => store.get(String(key)) })
      serve('kv.getUint8Array', { kind: 'call', run: ([key]) => store.getUint8Array(String(key)) })
      serve('kv.set', {
        kind: 'call',
        run: ([key, value]) => store.set(String(key), value instanceof Uint8Array ? value : String(value)),
      })
      serve('kv.remove', { kind: 'call', run: ([key]) => store.remove(String(key)) })
      serve('kv.keys', { kind: 'call', run: () => store.keys })
      serve('kv.size', { kind: 'call', run: () => Effect.map(store.keys, keys => keys.length) })
      serve('kv.clear', { kind: 'call', run: () => Effect.flatMap(store.keys, keys => Effect.forEach(keys, key => store.remove(key), { discard: true })) })

      serve('styles', { kind: 'stream', open: () => styles })
      // Its database, kept here.
      const Params = S.Array(SqlValueSchema)
      serve('data.query', {
        kind: 'call',
        run: ([sql, params]) => Effect.flatMap(decodeOrDie(Params)(params ?? []), decoded => data.query(String(sql), decoded)),
      })
      serve('data.run', {
        kind: 'call',
        run: ([sql, params]) => Effect.flatMap(decodeOrDie(Params)(params ?? []), decoded => data.run(String(sql), decoded)),
      })
      serve('data.changes', { kind: 'stream', open: () => data.changes })
      serve('settings.forMember', {
        kind: 'stream',
        open: ([memberId]) => settings.forMember(String(memberId)).pipe(Stream.map(values => values.values)),
      })

      // The registry: entries kept here, content and commands asked of the process.
      const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideContext(effect, context)
      serve('contributions.nav', {
        kind: 'scoped',
        acquire: ([entry]) => Effect.flatMap(decodeOrDie(NavEntry)(entry), decoded => provide(contributions.nav(decoded))),
      })
      serve('contributions.navChanges', { kind: 'stream', open: () => contributions.navChanges })
      serve('contributions.navEntries', { kind: 'call', run: () => contributions.navEntries })
      serve('contributions.slot', {
        kind: 'scoped',
        acquire: ([entry]) =>
          Effect.flatMap(decodeOrDie(Registration)(entry), ({ slot, id: entryId, key }) =>
            provide(
              contributions.slot({
                slot,
                id: entryId,
                content: slotContext =>
                  peer.stream('slot.open', [key, slotContext]).pipe(Stream.mapEffect(decodeOrDie(SlotContent)), Stream.orDie),
              }),
            ),
          ),
      })
      serve('contributions.badges', {
        kind: 'scoped',
        acquire: ([entry]) =>
          Effect.flatMap(decodeOrDie(Registration)(entry), ({ slot, id: entryId, key }) =>
            provide(
              contributions.badges({
                slot,
                id: entryId,
                content: slotContext =>
                  peer.stream('badges.open', [key, slotContext]).pipe(Stream.mapEffect(decodeOrDie(S.Array(Badge))), Stream.orDie),
              }),
            ),
          ),
      })
      serve('contributions.command', {
        kind: 'scoped',
        acquire: ([entry]) =>
          Effect.flatMap(decodeOrDie(CommandRegistration)(entry), ({ id: commandId, roles }) =>
            provide(
              contributions.command({
                id: commandId,
                ...(roles === null ? {} : { roles }),
                run: commandInput =>
                  peer.call('command.run', [commandId, commandInput]).pipe(
                    Effect.mapError(error => (typeof error === 'string' ? error : 'The action failed.')),
                    Effect.map(String),
                  ),
              }),
            ),
          ),
      })
      serve('contributions.run', {
        kind: 'call',
        run: ([commandId, commandInput]) =>
          Effect.flatMap(decodeOrDie(CommandInput)(commandInput), decoded => contributions.run(String(commandId), decoded)),
      })
      serve('contributions.slotCards', {
        kind: 'stream',
        open: ([slot, slotContext]) => Stream.unwrap(Effect.map(decodeOrDie(SlotContext)(slotContext), decoded => contributions.slotCards(String(slot), decoded))),
      })
      serve('contributions.slotBadges', {
        kind: 'stream',
        open: ([slot, slotContext]) => Stream.unwrap(Effect.map(decodeOrDie(SlotContext)(slotContext), decoded => contributions.slotBadges(String(slot), decoded))),
      })
      serve('contributions.inventory', { kind: 'call', run: () => contributions.inventory })
      serve('contributions.inventoryChanges', { kind: 'stream', open: () => contributions.inventoryChanges })

      // Pages: forwarded to the process, drained through it.
      serve('pages.mount', {
        kind: 'scoped',
        acquire: ([request]) =>
          Effect.flatMap(decodeOrDie(MountRequest)(request), ({ mountId, name, paths }) =>
            provide(
              pageHost.mountRoutes({
                name,
                routes: forwardingRoutes(peer, mountId, name, paths, options.identify),
                // A process that is gone has nothing left to drain.
                drain: peer.call('pages.drain', [mountId]).pipe(Effect.catchCause(() => Effect.void)),
              }),
            ),
          ),
      })
      serve('pages.names', { kind: 'call', run: () => pageHost.names })
      serve('pages.pages', { kind: 'call', run: () => pageHost.pages })

      // Start the extension in its process; stop it with the layer.
      yield* Effect.addFinalizer(() =>
        // A process that already ended is stopped too.
        peer.call('stop').pipe(Effect.timeoutOption('3 seconds'), Effect.catchCause(() => Effect.void)),
      )
      yield* peer.call('start', [{ id, values: input.values, secrets: input.secrets }]).pipe(
        Effect.mapError(error => (typeof error === 'string' ? error : JSON.stringify(error))),
        Effect.catchDefect(defect => Effect.fail(`The extension's process failed: ${String(defect)}`)),
      )

      // The watchdog.
      const heartbeat = options.heartbeat ?? Duration.seconds(1)
      const deadline = Duration.toMillis(Duration.fromInputUnsafe(options.deadline ?? Duration.seconds(5)))
      const watchdog = Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(heartbeat)
          const answer = yield* peer.call('ping').pipe(Effect.timeoutOption(Duration.millis(deadline)), Effect.option)
          if (Option.isNone(answer) || Option.isNone(answer.value)) {
            child.kill('SIGKILL')
            return yield* Effect.fail(
              `The extension did not answer for ${Math.round(deadline / 1000)} seconds (a blocked event loop?), so its process was stopped.`,
            )
          }
        }
      })
      const ended = Effect.flatMap(peer.closed, reason => Effect.fail(`The extension's process ended: ${reason}.`))
      yield* background(Effect.raceFirst(watchdog, ended))
    }),
  )
