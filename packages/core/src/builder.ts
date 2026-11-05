import type { Attribute, ChildAttribute, Html, HtmlBuilder } from 'foldkit/html'
import type * as Submodel from 'foldkit/submodel'

import { type Binder, mapBinder, rewriteAttributes } from './binding.ts'

/* A Foldkit `HtmlBuilder` for server-driven pages. Attribute constructors are
   Foldkit's own; only the element factories differ: they rewrite event
   attributes into Datastar bindings before delegating to Foldkit. Any view or
   component written against `HtmlBuilder<Message>` (crease/ui included)
   renders through it unchanged.

   The builder is created once per Foldkit builder and reused by every render
   of every session. The binder of the render in progress lives on a stack:
   views render synchronously, Foldkit forbids storing `h`, and Submodel slot
   callbacks get their parent's binder restored, exactly like Foldkit restores
   its own frames. Creating a builder (200 element closures) per render would
   cost allocations and, through the handler tables that outlive a render,
   memory. */

type AnyAttributes<Message> = ReadonlyArray<Attribute<Message> | ChildAttribute>
type ElementFactory<Message> = (
  attributes?: AnyAttributes<Message>,
  children?: ReadonlyArray<Html | string>,
) => Html

type Frame = Readonly<{ binder: Binder<unknown>; rootBinder: Binder<unknown> }>

const frames: Array<Frame> = []

const currentFrame = (): Frame => {
  const frame = frames[frames.length - 1]
  if (frame === undefined) {
    throw new Error(
      'hyper-effect: a server builder was used outside a render. Thread `h` through the view; never store it.',
    )
  }
  return frame
}

const withFrame = <A>(frame: Frame, render: () => A): A => {
  frames.push(frame)
  try {
    return render()
  } finally {
    frames.pop()
  }
}

/** Binds nothing: for markup that is built and thrown away. */
const discardingBinder: Binder<unknown> = {
  endpoint: '',
  bindMessage: () => "m: ''",
  registerHandler: () => 'discarded',
  registerInput: () => {},
}

/** Runs `f` where a server builder may be used but nothing it builds is kept.
 *  Event handlers run at event time, outside any render, and some call view
 *  code: crease's menus resolve their items, icons included, to find which
 *  items a key can move to. */
export const withDiscardedRender = <A>(f: () => A): A =>
  withFrame({ binder: discardingBinder, rootBinder: discardingBinder }, f)

/** Renders `view` with `binder` as the page's binder. */
export const withBinder = <Message, A>(binder: Binder<Message>, render: () => A): A =>
  /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
  withFrame({ binder: binder as Binder<unknown>, rootBinder: binder as Binder<unknown> }, render)

const serverBuilders = new WeakMap<object, HtmlBuilder<unknown>>()
const isServerBuilder = new WeakSet<object>()

/** The binder of the render in progress, when `h` is a server builder.
 *  Server-aware helpers (islands) use it to bind events themselves. */
export const binderOf = <Message>(h: HtmlBuilder<Message>): Binder<Message> | undefined =>
  isServerBuilder.has(h)
    ? /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
      (currentFrame().binder as Binder<Message>)
    : undefined

const isElementFactory = (key: string, value: unknown): boolean =>
  typeof value === 'function' &&
  /^[a-z]/.test(key) &&
  key !== 'keyed' &&
  key !== 'submodel'

/** Wraps a Submodel's slot callbacks so the elements they build bind to the
 *  parent's Messages, whatever frame is current when the child calls them. */
const wrapViewInputs = (viewInputs: unknown, outer: Frame): unknown => {
  if (typeof viewInputs !== 'object' || viewInputs === null || Array.isArray(viewInputs)) {
    return viewInputs
  }
  return Object.fromEntries(
    Object.entries(viewInputs).map(([key, value]) => [
      key,
      typeof value === 'function'
        ? (...args: ReadonlyArray<unknown>) => withFrame(outer, () => value(...args))
        : value,
    ]),
  )
}

/** The server builder for a Foldkit builder; use it inside `withBinder`. */
export const serverBuilder = <Message>(base: HtmlBuilder<Message>): HtmlBuilder<Message> => {
  const cached = serverBuilders.get(base)
  if (cached !== undefined) {
    /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
    return cached as HtmlBuilder<Message>
  }

  const rewrite = (attributes: AnyAttributes<Message> = []) => {
    const { binder, rootBinder } = currentFrame()
    /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
    return rewriteAttributes(attributes, binder as Binder<Message>, base, rootBinder)
  }

  const builder: Record<PropertyKey, unknown> = { ...base }

  for (const [key, value] of Object.entries(base)) {
    if (isElementFactory(key, value)) {
      /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
      const factory = value as ElementFactory<Message>
      builder[key] = (
        attributes?: AnyAttributes<Message>,
        children?: ReadonlyArray<Html | string>,
      ) => factory(rewrite(attributes), children)
    }
  }

  builder['keyed'] =
    (tagName: Parameters<HtmlBuilder<Message>['keyed']>[0]) =>
    (
      key: PropertyKey,
      attributes?: AnyAttributes<Message>,
      children?: ReadonlyArray<Html | string>,
    ) => {
      /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
      const keyed = base.keyed(tagName) as (
        key: PropertyKey,
        attributes?: AnyAttributes<Message>,
        children?: ReadonlyArray<Html | string>,
      ) => Html
      return keyed(key, rewrite(attributes), children)
    }

  // Foldkit's own `submodel` runs, so its boundary frames (and the
  // `toParentMessage` chain recorded on ChildAttributes) are real. The child
  // view renders through the server builder with a binder whose Messages map
  // into the parent's, exactly as Foldkit's runtime does at dispatch time,
  // just earlier: at render.
  builder['submodel'] = (
    config: Submodel.Config<Submodel.View<unknown, unknown, unknown>, Message>,
  ): Html => {
    const outer = currentFrame()
    const inner: Frame = {
      binder: mapBinder(outer.binder, config.toParentMessage as (message: unknown) => unknown),
      rootBinder: outer.rootBinder,
    }
    /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
    const view = config.view as unknown as (...args: ReadonlyArray<unknown>) => Html
    const serverView = (...args: ReadonlyArray<unknown>): Html => {
      /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
      const childBase = args[args.length - 1] as HtmlBuilder<unknown>
      return withFrame(inner, () => view(...args.slice(0, -1), serverBuilder(childBase)))
    }
    const viewInputs =
      config.viewInputs === undefined ? {} : { viewInputs: wrapViewInputs(config.viewInputs, outer) }
    /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
    return base.submodel({ ...config, ...viewInputs, view: serverView } as unknown as Parameters<
      HtmlBuilder<Message>['submodel']
    >[0])
  }

  /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
  const result = builder as unknown as HtmlBuilder<Message>
  serverBuilders.set(base, result as HtmlBuilder<unknown>)
  isServerBuilder.add(result)
  return result
}

/** Convenience for one-off renders (tests): the server builder bound to
 *  `binder` for the duration of `render`. */
export const renderWith = <Message, A>(
  base: HtmlBuilder<Message>,
  binder: Binder<Message>,
  render: (h: HtmlBuilder<Message>) => A,
): A => withBinder(binder, () => render(serverBuilder(base)))

type VNodeLike = Readonly<{
  sel?: string
  data?: Readonly<{ on?: Readonly<Record<string, unknown>> }>
  children?: ReadonlyArray<VNodeLike | string>
}>

/** Foldkit's serializer silently skips DOM listeners. A listener left on a
 *  vnode means an element was built outside the server builder, and its
 *  behavior would vanish from the page, so fail loudly instead. */
export const assertNoDroppedHandlers = (root: Html): void => {
  const dropped: Array<string> = []
  const visit = (node: VNodeLike | string | null | undefined): void => {
    if (node === null || node === undefined || typeof node === 'string') {
      return
    }
    const events = Object.keys(node.data?.on ?? {})
    if (events.length > 0) {
      dropped.push(`${node.sel ?? '?'} (${events.join(', ')})`)
    }
    node.children?.forEach(visit)
  }
  /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
  visit(root as VNodeLike | null)
  if (dropped.length > 0) {
    throw new Error(
      `hyper-effect: event listeners would be dropped from: ${dropped.join('; ')}. ` +
        "Build these elements with the view's h parameter.",
    )
  }
}
