import { afterAll, assert, describe, it } from '@effect/vitest'
import { Effect, Exit, Option, Schema as S, Stream, SubscriptionRef } from 'effect'
import type { HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import type { Program } from '../src/program'
import { region } from '../src/region'
import { shared } from '../src/shared'
import * as Session from '../src/session'
import { openPage, openStream, postEvent, serve, token } from '../src/testing'

/* Regions: re-render and re-send only what changed. */

const Model = S.Struct({ count: S.Number, name: S.String, showNotes: S.Boolean })
type Model = typeof Model.Type

const Message = defineMessageUnion({
  ClickedIncrement: {},
  ChangedName: { name: S.String },
  ToggledNotes: {},
})
type Message = typeof Message.Type

const view = (model: Model, h: HtmlBuilder<Message>) => ({
  title: 'regions',
  body: h.main(
    [],
    [
      // Part of the frame: changes only when the count reaches 2.
      h.p([h.Id('summary')], [model.count >= 2 ? 'many' : 'few']),
      region(h, {
        id: 'counter',
        deps: [model.count],
        render: () =>
          h.section(
            [h.Id('counter')],
            [h.button([h.OnClick(Message.ClickedIncrement())], ['+']), String(model.count)],
          ),
      }),
      region(h, {
        id: 'profile',
        deps: [model.name],
        render: () =>
          h.form(
            // A `>` inside an attribute value must not end the tag early.
            [h.Class('has-[>img]:pt-0'), h.Id('profile')],
            [
              h.input([
                h.Id('name'),
                h.Value(model.name),
                h.OnInput(name => Message.ChangedName({ name })),
              ]),
            ],
          ),
      }),
      ...(model.showNotes
        ? [region(h, { id: 'notes', deps: [], render: () => h.aside([h.Id('notes')], ['Notes']) })]
        : []),
    ],
  ),
})

const program: Program<Model, Message, Message> = {
  name: 'regions',
  Model,
  ClientMessage: Message,
  flags: () => Effect.void,
  init: () => ({ model: { count: 0, name: '', showNotes: false } }),
  update: (model, message) => {
    switch (message._tag) {
      case 'ClickedIncrement':
        return { model: { ...model, count: model.count + 1 } }
      case 'ChangedName':
        return { model: { ...model, name: message.name } }
      case 'ToggledNotes':
        return { model: { ...model, showNotes: !model.showNotes } }
    }
  },
  view,
}

const fresh = (served: Program<Model, Message, Message> = program) =>
  Session.make(served, 'region-test', { model: program.init().model, firstSequence: 1 })

const settle = (session: Session.Session<Model, Message>, predicate: (model: Model) => boolean) =>
  SubscriptionRef.changes(session.model).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.timeout('3 seconds'),
  )

const handlerIn = (html: string) => html.match(/h: '([^']+)'/)?.[1] ?? ''

describe('regions', () => {
  it.effect('render in place outside a session', () =>
    Effect.gen(function* () {
      const { html } = yield* Session.renderModel(program, program.init().model, {
        endpoint: '/x',
        bindMessage: message => `m: '${token(message)}'`,
        registerHandler: () => 'a.0',
        registerInput: () => {},
      })
      assert.include(html, '<section id="counter">')
      assert.notInclude(html, 'data-hyper-region')
    }),
  )

  it.live('render again only when their deps change; the frame stays the same', () =>
    Effect.gen(function* () {
      const session = yield* fresh()
      const first = yield* session.render
      yield* session.dispatch(Message.ClickedIncrement())
      yield* settle(session, model => model.count === 1)
      const second = yield* session.render

      assert.strictEqual(second.frame, first.frame)
      assert.include(first.frame, '<template data-hyper-region="counter"></template>')
      assert.strictEqual(second.regions.get('profile')?.version, first.regions.get('profile')?.version)
      assert.notStrictEqual(second.regions.get('counter')?.version, first.regions.get('counter')?.version)
      assert.include(second.regions.get('counter')?.html ?? '', '+</button>1</section>')
      // The full page has every region filled in.
      assert.include(second.html, 'id="profile"')
      assert.notInclude(second.html, 'data-hyper-region')
      yield* session.close
    }),
  )

  it.live('keep the handlers of an unchanged region for as long as it is shown', () =>
    Effect.gen(function* () {
      const session = yield* fresh()
      const first = yield* session.render
      const inputHandler = handlerIn(first.regions.get('profile')?.html ?? '')
      assert.match(inputHandler, /^\w+-\w+\.\w+$/)
      // Far beyond the retention of replaced tables (64 renders).
      for (let index = 0; index < 80; index += 1) yield* session.render
      assert.deepStrictEqual(
        session.resolve({ h: inputHandler, v: 'Ada' }),
        Option.some(Message.ChangedName({ name: 'Ada' })),
      )
      yield* session.close
    }),
  )

  it.live('that leave the page are forgotten, and come back with new markup', () =>
    Effect.gen(function* () {
      const session = yield* fresh()
      yield* session.dispatch(Message.ToggledNotes())
      yield* settle(session, model => model.showNotes)
      const shown = (yield* session.render).regions.get('notes')?.version
      yield* session.dispatch(Message.ToggledNotes())
      yield* settle(session, model => !model.showNotes)
      assert.isFalse((yield* session.render).regions.has('notes'))
      yield* session.dispatch(Message.ToggledNotes())
      yield* settle(session, model => model.showNotes)
      const again = (yield* session.render).regions.get('notes')?.version
      assert.isDefined(shown)
      assert.isAbove(again ?? 0, shown ?? 0)
      yield* session.close
    }),
  )

  it.live('with incomplete deps fail outside production', () =>
    Effect.gen(function* () {
      const stale = yield* fresh({
        ...program,
        view: (model, h) => ({
          title: 'stale',
          // The view reads the count, the deps do not name it.
          body: region(h, { id: 'stale', deps: [], render: () => h.p([h.Id('stale')], [String(model.count)]) }),
        }),
      })
      yield* stale.render
      yield* stale.dispatch(Message.ClickedIncrement())
      yield* settle(stale, model => model.count === 1)
      const exit = yield* Effect.exit(stale.render)
      assert.isTrue(Exit.isFailure(exit))
      assert.include(String(Exit.isFailure(exit) ? exit.cause : ''), 'renders differently with the same deps')
      yield* stale.close
    }),
  )

  it.live('must be placed once per render, as an element with their id', () =>
    Effect.gen(function* () {
      const twice = yield* fresh({
        ...program,
        view: (_, h) => ({
          title: 'twice',
          body: h.div(
            [],
            [1, 2].map(() =>
              region(h, { id: 'same', deps: [], render: () => h.p([h.Id('same')], []) }),
            ),
          ),
        }),
      })
      assert.isTrue(Exit.isFailure(yield* Effect.exit(twice.render)))
      const unnamed = yield* fresh({
        ...program,
        view: (_, h) => ({
          title: 'unnamed',
          body: region(h, { id: 'mine', deps: [], render: () => h.p([], ['no id']) }),
        }),
      })
      assert.isTrue(Exit.isFailure(yield* Effect.exit(unnamed.render)))
      yield* Effect.all([twice.close, unnamed.close])
    }),
  )
})

// NESTED REGIONS

const Item = S.Struct({ id: S.String, label: S.String })
const ListModel = S.Struct({ items: S.Array(Item), count: S.Number })
type ListModel = typeof ListModel.Type

const ListMessage = defineMessageUnion({
  Renamed: { id: S.String, label: S.String },
  ClickedIncrement: {},
  ChangedName: { name: S.String },
})
type ListMessage = typeof ListMessage.Type

const listView =
  (listDeps: (model: ListModel) => ReadonlyArray<unknown>) =>
  (model: ListModel, h: HtmlBuilder<ListMessage>) => ({
    title: 'list',
    body: h.main(
      [],
      [
        region(h, {
          id: 'list',
          deps: listDeps(model),
          render: () =>
            h.ul(
              [h.Id('list')],
              model.items.map(item =>
                region(h, {
                  id: `item-${item.id}`,
                  deps: [item],
                  render: () => h.li([h.Id(`item-${item.id}`)], [item.label]),
                }),
              ),
            ),
        }),
        region(h, {
          id: 'echo',
          deps: [model.count],
          // The markup does not show the count; only the handler uses it.
          render: () =>
            h.form(
              [h.Id('echo')],
              [h.input([h.Id('echo-name'), h.OnInput(name => ListMessage.ChangedName({ name: `${name}${model.count}` }))])],
            ),
        }),
      ],
    ),
  })

const listProgram: Program<ListModel, ListMessage, ListMessage> = {
  name: 'list',
  Model: ListModel,
  ClientMessage: ListMessage,
  flags: () => Effect.void,
  init: () => ({
    model: {
      items: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      count: 0,
    },
  }),
  update: (model, message) => {
    switch (message._tag) {
      case 'Renamed':
        return {
          model: {
            ...model,
            // Every item is a new object, as data arriving in a Foldkit Message
            // is: deps compare by value, so unchanged rows are still kept.
            items: model.items.map(item => (item.id === message.id ? { ...item, label: message.label } : { ...item })),
          },
        }
      case 'ClickedIncrement':
        return { model: { ...model, count: model.count + 1 } }
      case 'ChangedName':
        return { model }
    }
  },
  view: listView(model => [model.items]),
}

const freshList = (served: Program<ListModel, ListMessage, ListMessage> = listProgram) =>
  Session.make(served, 'list-test', { model: listProgram.init().model, firstSequence: 1 })

const settleList = (session: Session.Session<ListModel, ListMessage>, predicate: (model: ListModel) => boolean) =>
  SubscriptionRef.changes(session.model).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.timeout('3 seconds'),
  )

describe('nested regions', () => {
  it.live('render again around one changed row, and only the row gets a new version', () =>
    Effect.gen(function* () {
      const session = yield* freshList()
      const first = yield* session.render
      yield* session.dispatch(ListMessage.Renamed({ id: 'b', label: 'B2' }))
      yield* settleList(session, model => model.items[1]?.label === 'B2')
      const second = yield* session.render

      const version = (rendered: Session.Rendered, regionId: string) => rendered.regions.get(regionId)?.version
      assert.strictEqual(version(second, 'list'), version(first, 'list'))
      assert.strictEqual(version(second, 'item-a'), version(first, 'item-a'))
      assert.notStrictEqual(version(second, 'item-b'), version(first, 'item-b'))
      assert.strictEqual(second.regions.get('item-b')?.parent, 'list')
      // Filled markup carries the nested regions.
      assert.include(second.regions.get('list')?.html ?? '', '<li id="item-b">B2</li>')
      assert.include(second.html, '<li id="item-a">A</li>')
      yield* session.close
    }),
  )

  it.live('that render the same markup keep their version; its handler ids name the fresh handlers', () =>
    Effect.gen(function* () {
      const session = yield* freshList()
      const first = yield* session.render
      const handlerId = handlerIn(first.regions.get('echo')?.html ?? '')
      yield* session.dispatch(ListMessage.ClickedIncrement())
      yield* settleList(session, model => model.count === 1)
      const second = yield* session.render
      assert.strictEqual(second.regions.get('echo')?.version, first.regions.get('echo')?.version)
      assert.deepStrictEqual(
        session.resolve({ h: handlerId, v: 'Ada' }),
        Option.some(ListMessage.ChangedName({ name: 'Ada1' })),
      )
      yield* session.close
    }),
  )

  it.live('with upload bindings keep their version when only handler ids change', () =>
    Effect.gen(function* () {
      const session = yield* fresh({
        ...program,
        view: (model, h) => ({
          title: 'files',
          body: h.div(
            [],
            [
              region(h, {
                id: 'files',
                // Rendered again on every count, to identical markup.
                deps: [model.count],
                render: () =>
                  h.div(
                    [h.Id('files'), h.AllowDrop(), h.OnDropFiles(() => Message.ToggledNotes())],
                    [h.input([h.Id('file'), h.Type('file'), h.OnFileChange(() => Message.ToggledNotes())])],
                  ),
              }),
              // Kept on every count: the development check renders it again.
              region(h, {
                id: 'kept',
                deps: [],
                render: () => h.input([h.Id('kept'), h.Type('file'), h.OnFileChange(() => Message.ToggledNotes())]),
              }),
            ],
          ),
        }),
      })
      const first = yield* session.render
      yield* session.dispatch(Message.ClickedIncrement())
      yield* settle(session, model => model.count === 1)
      const second = yield* session.render
      assert.strictEqual(second.regions.get('files')?.version, first.regions.get('files')?.version)
      assert.strictEqual(second.regions.get('kept')?.version, first.regions.get('kept')?.version)
      yield* session.close
    }),
  )

  it.live('fail outside production when a region keeps its deps while a nested region changes', () =>
    Effect.gen(function* () {
      const session = yield* freshList({ ...listProgram, view: listView(() => []) })
      yield* session.render
      yield* session.dispatch(ListMessage.Renamed({ id: 'b', label: 'B2' }))
      yield* settleList(session, model => model.items[1]?.label === 'B2')
      const exit = yield* Effect.exit(session.render)
      assert.isTrue(Exit.isFailure(exit))
      assert.include(String(Exit.isFailure(exit) ? exit.cause : ''), 'nested region "item-b"')
      yield* session.close
    }),
  )

  it.live('render in place inside shared markup', () =>
    Effect.gen(function* () {
      const session = yield* fresh({
        ...program,
        view: (_, h) => ({
          title: 'shared',
          body: h.div(
            [],
            [
              shared(h, {
                key: `region-test:${crypto.randomUUID()}`,
                deps: [],
                render: () => [region(h, { id: 'inner', deps: [], render: () => h.p([h.Id('inner')], ['Inside']) })],
              }),
            ],
          ),
        }),
      })
      const rendered = yield* session.render
      assert.include(rendered.frame, '<p id="inner">Inside</p>')
      assert.isFalse(rendered.regions.has('inner'))
      yield* session.close
    }),
  )
})

describe('region patches on the stream', () => {
  const server = serve(program)
  afterAll(() => server.dispose())

  /** Reads `datastar-patch-elements` events one by one. */
  const patchesOf = (response: Response) => {
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const next = async (): Promise<string> => {
      while (!buffer.includes('\n\n')) {
        const { value, done } = await reader.read()
        if (done) throw new Error('stream ended')
        buffer += decoder.decode(value, { stream: true })
      }
      const at = buffer.indexOf('\n\n')
      const event = buffer.slice(0, at)
      buffer = buffer.slice(at + 2)
      return event.startsWith('event: datastar-patch-elements') ? event : next()
    }
    return { next, close: () => reader.cancel() }
  }

  it('send only changed regions while the frame is unchanged, and the page when it changes', async () => {
    const page = await openPage(server.handler)
    const patches = patchesOf(await openStream(server.handler, page))
    try {
      const initial = await patches.next()
      assert.include(initial, 'id="hyper-root"')
      assert.include(initial, 'id="hyper-title"')

      await postEvent(server.handler, page, { m: token({ _tag: 'ClickedIncrement' }), q: 1 })
      const counterOnly = await patches.next()
      assert.include(counterOnly, '<section id="counter">')
      assert.notInclude(counterOnly, 'hyper-root')
      assert.notInclude(counterOnly, 'id="profile"')
      // The title did not change, so it is not sent again.
      assert.notInclude(counterOnly, 'hyper-title')

      // The count reaches 2: the frame's summary changes, so the whole page goes.
      await postEvent(server.handler, page, { m: token({ _tag: 'ClickedIncrement' }), q: 2 })
      const whole = await patches.next()
      assert.include(whole, 'id="hyper-root"')
      assert.include(whole, '>many</p>')
    } finally {
      await patches.close()
    }
  })

  it('send one changed row, not the list around it', async () => {
    const listServer = serve(listProgram)
    try {
      const page = await openPage(listServer.handler)
      const patches = patchesOf(await openStream(listServer.handler, page))
      try {
        assert.include(await patches.next(), 'id="hyper-root"')
        await postEvent(listServer.handler, page, { m: token({ _tag: 'Renamed', id: 'b', label: 'B2' }), q: 1 })
        const row = await patches.next()
        assert.include(row, '<li id="item-b">B2</li>')
        assert.notInclude(row, 'id="list"')
        assert.notInclude(row, 'item-a')
      } finally {
        await patches.close()
      }
    } finally {
      await listServer.dispose()
    }
  })
})
