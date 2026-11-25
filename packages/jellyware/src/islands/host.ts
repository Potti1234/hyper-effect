import { ISLAND_EVENT, PROPS_ATTRIBUTE } from '@hyper-effect/island/contract'

import { HOST_TAG, MAX_FRAME_HEIGHT, type ToFrame, fromFrame } from './contract.ts'

/* In the page: the element that hosts an extension's island in a
   sandboxed frame. The app's islands bundle registers it once
   (`registerIslandHost()`).

   Its `data-props` (rendered by `islandView` on the server) hold the
   frame's address, its height (null: as tall as its content), a label and
   the island's props. New props go to the frame; a new address (a new
   version of the extension) loads the frame again. Messages count only
   from this element's own frame; its events leave as `island-event`, which
   the server-rendered page binds like any island's. */

type Hosted = Readonly<{ src: string; height: number | null; label: string; props: unknown }>

const parse = (text: string | null): Hosted | null => {
  try {
    const value: unknown = JSON.parse(text ?? 'null')
    if (typeof value !== 'object' || value === null) return null
    const record: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(value))
    const { src, height, label, props } = record
    if (typeof src !== 'string' || !src.startsWith('/')) return null
    return { src, height: typeof height === 'number' ? height : null, label: typeof label === 'string' ? label : '', props }
  } catch {
    return null
  }
}

export const registerIslandHost = (): void => {
  if (customElements.get(HOST_TAG) !== undefined) return

  class IslandHost extends HTMLElement {
    static observedAttributes = [PROPS_ATTRIBUTE]
    #frame: HTMLIFrameElement | undefined
    #ready = false
    #hosted: Hosted | null = null
    #theme: MutationObserver | undefined
    #pendingDispose: ReturnType<typeof setTimeout> | undefined

    #post(message: ToFrame) {
      if (this.#ready) this.#frame?.contentWindow?.postMessage(message, '*')
    }

    #dark() {
      return this.closest('.dark') !== null
    }

    #onMessage = (event: MessageEvent) => {
      if (this.#frame === undefined || event.source !== this.#frame.contentWindow) return
      const message = fromFrame(event.data)
      if (message === null) return
      switch (message.type) {
        case 'ready':
          this.#ready = true
          this.#post({ type: 'theme', dark: this.#dark() })
          this.#post({ type: 'props', props: this.#hosted?.props })
          return
        case 'event':
          this.dispatchEvent(new CustomEvent(ISLAND_EVENT, { detail: message.detail }))
          return
        case 'height':
          if (this.#hosted?.height === null) this.#frame.style.height = `${Math.max(24, Math.min(MAX_FRAME_HEIGHT, message.height))}px`
          return
        case 'error':
          this.setAttribute('data-island-error', message.message)
          return
      }
    }

    #load(hosted: Hosted) {
      const frame = this.#frame
      if (frame === undefined) return
      this.#ready = false
      this.removeAttribute('data-island-error')
      frame.title = hosted.label
      frame.style.height = `${hosted.height ?? 120}px`
      frame.src = hosted.src
    }

    connectedCallback() {
      if (this.#pendingDispose !== undefined) {
        clearTimeout(this.#pendingDispose)
        this.#pendingDispose = undefined
      }
      if (this.#frame !== undefined) return
      // The server's wrapper keeps morphs out of the frame.
      const wrapper = this.querySelector<HTMLElement>('[data-island-root]') ?? this.appendChild(document.createElement('div'))
      wrapper.setAttribute('data-ignore-morph', '')
      const frame = document.createElement('iframe')
      // Scripts only: an opaque origin, no cookies or storage of the app,
      // no access to this page, no forms, popups or navigation of the page.
      frame.setAttribute('sandbox', 'allow-scripts')
      frame.setAttribute('referrerpolicy', 'no-referrer')
      frame.setAttribute('loading', 'lazy')
      frame.style.cssText = 'display:block;width:100%;border:0;background:transparent;color-scheme:normal'
      wrapper.appendChild(frame)
      this.#frame = frame
      window.addEventListener('message', this.#onMessage)
      // The page's colour scheme, now and when it changes.
      const themed = this.closest('#app') ?? document.documentElement
      this.#theme = new MutationObserver(() => this.#post({ type: 'theme', dark: this.#dark() }))
      this.#theme.observe(themed, { attributes: true, attributeFilter: ['class'] })
      this.#hosted = parse(this.getAttribute(PROPS_ATTRIBUTE))
      if (this.#hosted !== null) this.#load(this.#hosted)
    }

    attributeChangedCallback(_name: string, previous: string | null, next: string | null) {
      if (this.#frame === undefined || next === previous) return
      const hosted = parse(next)
      if (hosted === null) return
      const reload = hosted.src !== this.#hosted?.src
      this.#hosted = hosted
      if (reload) this.#load(hosted)
      else this.#post({ type: 'props', props: hosted.props })
    }

    disconnectedCallback() {
      // A morph that moves the element reconnects it in the same task.
      this.#pendingDispose = setTimeout(() => {
        window.removeEventListener('message', this.#onMessage)
        this.#theme?.disconnect()
        this.#frame?.remove()
        this.#frame = undefined
        this.#pendingDispose = undefined
      }, 0)
    }
  }

  customElements.define(HOST_TAG, IslandHost)
}
