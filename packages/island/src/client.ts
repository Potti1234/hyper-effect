import { Schema } from 'effect'
import { Runtime } from 'foldkit'

import { ISLAND_EVENT, type IslandSpec, PROPS_ATTRIBUTE } from './contract.ts'

/* Browser side of an island: a custom element that boots a Foldkit program
   with `Runtime.embed`, feeds `data-props` changes into its `props` inbound
   Port and re-emits its `events` outbound Port as `island-event` DOM events. */

type IslandHandle = Readonly<{
  ports: Readonly<{
    props: Readonly<{ send: (value: unknown) => unknown }>
    events: Readonly<{ subscribe: (listener: (value: unknown) => void) => () => void }>
  }>
  dispose: () => void
}>

export const register = <Tag extends string, Props, Event>(
  spec: IslandSpec<Tag, Props, Event>,
  /** Builds the island's program with `Runtime.makeElement`. It must declare
   *  `ports: { inbound: { props }, outbound: { events } }`. */
  make: (container: HTMLElement, props: Props) => unknown,
): void => {
  if (customElements.get(spec.tag) !== undefined) return
  const decodeProps = Schema.decodeUnknownSync(Schema.toCodecJson(spec.Props))

  class Island extends HTMLElement {
    static observedAttributes = [PROPS_ATTRIBUTE]
    #handle: IslandHandle | undefined
    #pendingDispose: ReturnType<typeof setTimeout> | undefined

    connectedCallback() {
      // A morph that moves the element disconnects and reconnects it in one
      // task; keep the running program instead of rebuilding it.
      if (this.#pendingDispose !== undefined) {
        clearTimeout(this.#pendingDispose)
        this.#pendingDispose = undefined
      }
      if (this.#handle !== undefined) return
      // The server's wrapper carries `data-ignore-morph` and must stay: Foldkit
      // replaces its container element on the first render, so it gets a
      // fresh element inside the wrapper instead of the wrapper itself.
      const wrapper =
        this.querySelector<HTMLElement>('[data-island-root]') ??
        this.appendChild(document.createElement('div'))
      wrapper.setAttribute('data-ignore-morph', '')
      wrapper.style.height = '100%'
      const container = wrapper.appendChild(document.createElement('div'))
      // Foldkit keys its runtime by the container id.
      container.id = `${this.id === '' ? spec.tag : this.id}-root`
      const props = decodeProps(JSON.parse(this.getAttribute(PROPS_ATTRIBUTE) ?? 'null'))
      /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
      const handle = Runtime.embed(make(container, props) as never) as unknown as IslandHandle
      handle.ports.events.subscribe(detail => {
        this.dispatchEvent(new CustomEvent(ISLAND_EVENT, { detail }))
      })
      this.#handle = handle
    }

    attributeChangedCallback(_name: string, previous: string | null, next: string | null) {
      if (this.#handle !== undefined && next !== null && next !== previous) {
        this.#handle.ports.props.send(JSON.parse(next))
      }
    }

    disconnectedCallback() {
      this.#pendingDispose = setTimeout(() => {
        this.#handle?.dispose()
        this.#handle = undefined
        this.#pendingDispose = undefined
      }, 0)
    }
  }

  customElements.define(spec.tag, Island)
}
