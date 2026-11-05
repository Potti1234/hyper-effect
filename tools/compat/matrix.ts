/* Compatibility matrix (experiment 3): renders every crease/ui component
   demo through hyper-effect's server builder and classifies it.

   Runs inside the environment `run.mjs` prepares (hyper-effect's framework
   next to this file, crease's node_modules shared, `@/` mapped to crease's
   src), so crease and hyper-effect share one Foldkit instance. */

import { writeFileSync } from 'node:fs'

import { Cause, Effect, Exit, Schema as S } from 'effect'
import type { HtmlBuilder } from 'foldkit/html'

import { type Binder, type Handler, UnsupportedEventError } from './hyper/binding'
import { withDiscardedRender } from './hyper/builder'
import { foldkitUiCommands } from './hyper/client-commands'
import type { Program } from './hyper/program'
import { renderModel } from './hyper/session'

const { authoredPages } = await import('@/docs/components/pages/index')

type Tier =
  | 'static'
  | 'server-interactive'
  | 'server-submodel'
  | 'degraded'
  | 'island'
  | 'error'

const TIER_ORDER: ReadonlyArray<Tier> = [
  'static',
  'server-interactive',
  'server-submodel',
  'degraded',
  'island',
  'error',
]

type ExampleResult = {
  tier: Tier
  messages: number
  handlers: Array<string>
  inputs: number
  dropped: Array<string>
  unsupported?: string
  browserCommands: Array<string>
  forwardedCommands: Array<string>
  interaction: 'ok' | 'none' | string
  /** The keyboard pass: keys pressed on the component's key handlers. */
  keyboard: 'ok' | 'none' | string
  error?: string
}

const BROWSER_GLOBAL = /\b(window|document|navigator|requestAnimationFrame|localStorage|matchMedia|HTMLElement|ResizeObserver|IntersectionObserver)\b/

const decodeToken = (value: string): unknown =>
  JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))

const runExample = async (
  page: (typeof authoredPages)[string],
  index: number,
): Promise<ExampleResult> => {
  const preview = page.previewProgram!
  const messageJson = S.toCodecJson(preview.Message)
  const encodeMessage = S.encodeUnknownSync(messageJson)
  const decodeMessage = S.decodeUnknownSync(messageJson)
  const program: Program<unknown, unknown, unknown> = {
    name: 'matrix',
    Model: preview.Model as never,
    ClientMessage: preview.Message as never,
    flags: () => Effect.void,
    init: () => ({ model: preview.init(index) }),
    update: preview.update as never,
    view: (model, h) => ({
      title: page.title,
      body: preview.view(index, model, h as HtmlBuilder<never>),
    }),
  }

  const handlers: Array<Handler<unknown>> = []
  let messages = 0
  let inputs = 0
  const binder: Binder<unknown> = {
    endpoint: '/matrix',
    bindMessage: message => {
      messages += 1
      try {
        return `m: '${Buffer.from(JSON.stringify(encodeMessage(message))).toString('base64url')}'`
      } catch {
        // As the session does: a Message that is not JSON-encodable becomes a handler.
        handlers.push({ _tag: 'Message', message })
        return `h: 'a.${handlers.length - 1}'`
      }
    },
    registerHandler: handler => {
      handlers.push(handler)
      return `a.${handlers.length - 1}`
    },
    registerInput: () => {
      inputs += 1
    },
  }

  const result: ExampleResult = {
    tier: 'static',
    messages: 0,
    handlers: [],
    inputs: 0,
    dropped: [],
    browserCommands: [],
    forwardedCommands: [],
    interaction: 'none',
    keyboard: 'none',
  }

  const model = preview.init(index)
  const first = await Effect.runPromiseExit(renderModel(program, model, binder, { validate: true }))
  result.messages = messages
  result.handlers = handlers.map(handler => handler._tag)
  result.inputs = inputs
  if (Exit.isFailure(first)) {
    const defect = Cause.squash(first.cause)
    if (defect instanceof UnsupportedEventError) {
      result.tier = 'island'
      result.unsupported = defect.tag
    } else {
      result.tier = 'error'
      const detail = (defect as { cause?: unknown }).cause ?? defect
      result.error = String(detail).split('\n')[0]?.slice(0, 240)
    }
    return result
  }
  const html = first.value.html
  result.dropped = [...new Set([...html.matchAll(/data-hyper-dropped="([^"]+)"/g)].map(match => match[1] ?? ''))]

  // One interaction: the first clickable Message, else the first typed value.
  const token = html.match(/data-on:click[^=]*="[^"]*m: '([A-Za-z0-9_-]+)'/)?.[1]
  const valueHandler = handlers.find(handler => handler._tag === 'Value')
  let message: unknown
  try {
    if (token !== undefined) message = decodeMessage(decodeToken(token))
    else if (valueHandler?._tag === 'Value') message = valueHandler.f('a')
  } catch (error) {
    result.interaction = `decode failed: ${String(error).slice(0, 100)}`
  }
  /** Runs a Message's Commands as the session would: forwarded ones are
   *  noted, the others run, and those that need a browser are recorded. */
  const runCommands = async (commands: ReadonlyArray<{ name: string; args?: unknown; effect: unknown }>) => {
    for (const command of commands) {
      const forward = foldkitUiCommands[command.name]
      if (forward?.((command.args ?? {}) as Readonly<Record<string, unknown>>) !== undefined) {
        if (!result.forwardedCommands.includes(command.name)) result.forwardedCommands.push(command.name)
        continue
      }
      const exit = await Effect.runPromiseExit(
        (command.effect as Effect.Effect<unknown>).pipe(Effect.timeout('300 millis')),
      )
      if (Exit.isFailure(exit)) {
        const text = Cause.pretty(exit.cause)
        if (BROWSER_GLOBAL.test(text) && !result.browserCommands.includes(command.name)) {
          result.browserCommands.push(command.name)
        }
      }
    }
  }

  if (message !== undefined) {
    try {
      const next = preview.update(model, message as never)
      await runCommands((next.commands ?? []) as never)
      const again = await Effect.runPromiseExit(
        renderModel(program, next.model, binder, { validate: true }),
      )
      result.interaction = Exit.isSuccess(again)
        ? 'ok'
        : `re-render failed: ${String((Cause.squash(again.cause) as { cause?: unknown }).cause ?? Cause.squash(again.cause)).slice(0, 200)}`
    } catch (error) {
      result.interaction = `update failed: ${String(error).slice(0, 100)}`
    }
  }

  // The keyboard pass: what a user does on a focused widget (open, move,
  // choose, close). Each press goes to the first key handler that takes it,
  // after a fresh render, as the session would bind it.
  if (handlers.some(handler => handler._tag === 'Key')) {
    let current: unknown = model
    let pressed = 0
    try {
      for (const key of ['ArrowDown', 'ArrowDown', 'Enter', 'Escape']) {
        handlers.length = 0
        const rendered = await Effect.runPromiseExit(renderModel(program, current, binder, { validate: true }))
        if (Exit.isFailure(rendered)) throw new Error(`render failed before ${key}`)
        let chosen: unknown
        for (const handler of handlers) {
          if (handler._tag !== 'Key') continue
          // As the session does at event time: in a discarded render frame.
          const found = withDiscardedRender(() =>
            handler.f(key, { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }),
          )
          if (found._tag === 'Some') {
            chosen = found.value
            break
          }
        }
        if (chosen === undefined) continue
        pressed += 1
        const next = preview.update(current as never, chosen as never)
        await runCommands((next.commands ?? []) as never)
        current = next.model
      }
      result.keyboard = pressed === 0 ? 'none' : 'ok'
    } catch (error) {
      result.keyboard = `failed: ${String(error).slice(0, 100)}`
    }
  }

  const interactive = result.messages > 0 || result.handlers.length > 0
  result.tier =
    result.dropped.length > 0 || result.browserCommands.length > 0
      ? 'degraded'
      : page.kind === 'submodel'
        ? 'server-submodel'
        : interactive
          ? 'server-interactive'
          : 'static'
  return result
}

const worst = (tiers: ReadonlyArray<Tier>): Tier =>
  tiers.reduce((a, b) => (TIER_ORDER.indexOf(b) > TIER_ORDER.indexOf(a) ? b : a), 'static' as Tier)

const rows: Array<Record<string, unknown>> = []
for (const page of Object.values(authoredPages)) {
  if (page.previewProgram === undefined) continue
  const count = Math.max(1, page.definition.examples?.length ?? 1)
  const examples: Array<ExampleResult> = []
  for (let index = 0; index < count; index += 1) {
    examples.push(await runExample(page, index))
  }
  rows.push({
    slug: page.slug,
    title: page.title,
    kind: page.kind,
    examples: count,
    tier: worst(examples.map(example => example.tier)),
    messages: examples.reduce((sum, example) => sum + example.messages, 0),
    handlers: [...new Set(examples.flatMap(example => example.handlers))],
    inputs: examples.reduce((sum, example) => sum + example.inputs, 0),
    dropped: [...new Set(examples.flatMap(example => example.dropped))],
    unsupported: [...new Set(examples.flatMap(example => (example.unsupported === undefined ? [] : [example.unsupported])))],
    browserCommands: [...new Set(examples.flatMap(example => example.browserCommands))],
    forwardedCommands: [...new Set(examples.flatMap(example => example.forwardedCommands))],
    interactions: examples.map(example => example.interaction),
    keyboard: examples.map(example => example.keyboard),
    errors: [...new Set(examples.flatMap(example => (example.error === undefined ? [] : [example.error])))],
  })
}

const output = process.argv[2]
if (output !== undefined) writeFileSync(output, JSON.stringify(rows, null, 2))
const counts = rows.reduce<Record<string, number>>((acc, row) => {
  const tier = String(row['tier'])
  acc[tier] = (acc[tier] ?? 0) + 1
  return acc
}, {})
console.log(JSON.stringify(counts))
