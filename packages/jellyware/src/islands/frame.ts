import { Schema } from 'effect'
import { Runtime } from 'foldkit'

import { type FromFrame, type IslandSpec, toFrame } from './contract.ts'

/* Inside the frame: boots an extension's island when the page sends its
   first props, sends its events and its height to the page, and reports a
   failure. The island module calls `runIsland` at its top level:

     runIsland(Heatmap, (container, props) =>
       Runtime.makeElement({ Model, Flags: Heatmap.Props, flags: Effect.succeed(props),
                             init, update, view, subscriptions, ports, container }))

   The frame is sandboxed (an opaque origin: no cookies, no storage, no
   access to the page) and its content security policy allows no network,
   so the page is the island's only way out, through its events. */

type Handle = Readonly<{
  ports: Readonly<{
    props: Readonly<{ send: (value: unknown) => unknown }>
    events: Readonly<{ subscribe: (listener: (value: unknown) => void) => () => void }>
  }>
}>

const isHandle = (value: unknown): value is Handle => {
  if (typeof value !== 'object' || value === null || !('ports' in value)) return false
  const ports = value.ports
  return typeof ports === 'object' && ports !== null && 'props' in ports && 'events' in ports
}

export const runIsland = <Props, Event>(
  spec: IslandSpec<Props, Event>,
  /** Builds the island's program with `Runtime.makeElement`; it must
   *  declare `ports: islandPorts(spec)`. */
  make: (container: HTMLElement, props: Props) => unknown,
): void => {
  const decodeProps = Schema.decodeUnknownSync(Schema.toCodecJson(spec.Props))
  const send = (message: FromFrame) => window.parent.postMessage(message, '*')
  const fail = (error: unknown) => send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  window.addEventListener('error', event => fail(event.error ?? event.message))
  window.addEventListener('unhandledrejection', event => fail(event.reason))

  let handle: Handle | undefined
  window.addEventListener('message', event => {
    if (event.source !== window.parent) return
    const message = toFrame(event.data)
    if (message === null) return
    if (message.type === 'theme') {
      document.documentElement.classList.toggle('dark', message.dark)
      return
    }
    if (handle !== undefined) {
      handle.ports.props.send(message.props)
      return
    }
    try {
      const container = document.getElementById('island') ?? document.body.appendChild(document.createElement('div'))
      // `make` builds a Foldkit element program whose type the frame cannot
      // name; `isHandle` checks what comes back.
      /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
      const embedded: unknown = Runtime.embed(make(container, decodeProps(message.props)) as never)
      if (!isHandle(embedded)) throw new Error('The island did not declare its ports (islandPorts).')
      handle = embedded
      handle.ports.events.subscribe(detail => send({ type: 'event', detail }))
    } catch (error) {
      fail(error)
    }
  })

  // The page sizes the frame to its content.
  let last = 0
  new ResizeObserver(() => {
    const height = Math.ceil(document.documentElement.getBoundingClientRect().height)
    if (height !== last) {
      last = height
      send({ type: 'height', height })
    }
  }).observe(document.documentElement)
  send({ type: 'ready' })
}
