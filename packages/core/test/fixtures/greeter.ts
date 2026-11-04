import { Clock, Effect, Match as M, Schema as S, Stream } from 'effect'
import { Command } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { Subscription } from 'foldkit'
import type { Update } from 'foldkit'

import type { Program } from '../../src/program'

/* Test fixture: the greeter spike with plain Foldkit elements instead of
   crease/ui, so core's tests depend on nothing but Foldkit. Same Model,
   Messages, Command and Subscription as examples/dispatch/src/app/greeter.ts. */

// MODEL

const Idle = S.TaggedStruct('Idle', {})
const Saving = S.TaggedStruct('Saving', { name: S.String })
const SaveState = S.Union([Idle, Saving])

export const Model = S.Struct({
  count: S.Number,
  name: S.String,
  greetings: S.Array(S.String),
  saveState: SaveState,
  serverTime: S.String,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ClickedIncrement: {},
  ClickedDecrement: {},
  ChangedName: { name: S.String },
  SubmittedGreeting: {},
  SucceededSaveGreeting: { greeting: S.String },
  TickedClock: { time: S.String },
})
export type Message = typeof Message.Type

/** Messages a browser may post. Command results and clock ticks are absent,
 *  so a client cannot forge them. */
export const ClientMessage = S.Union([
  Message.ClickedIncrement,
  Message.ClickedDecrement,
  Message.SubmittedGreeting,
])
export type ClientMessage = typeof ClientMessage.Type

// COMMAND

export const SaveGreeting = Command.define('SaveGreeting', {
  args: { name: S.String },
  messages: [Message.SucceededSaveGreeting],
  execute: ({ name }) =>
    Effect.sleep('400 millis').pipe(
      Effect.as(Message.SucceededSaveGreeting({ greeting: `Hello, ${name}!` })),
    ),
})

// INIT

export const init = (): Update.Return<Model, Message> => ({
  model: {
    count: 0,
    name: '',
    greetings: [],
    saveState: Idle.make({}),
    serverTime: '--:--:--',
  },
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message>

export const update = (model: Model, message: Message): UpdateReturn =>
  M.value(message).pipe(
    M.withReturnType<UpdateReturn>(),
    M.tagsExhaustive({
      ClickedIncrement: () => ({ model: { ...model, count: model.count + 1 } }),
      ClickedDecrement: () => ({ model: { ...model, count: model.count - 1 } }),
      ChangedName: ({ name }) => ({ model: { ...model, name } }),
      SubmittedGreeting: () => {
        const name = model.name.trim()
        if (name === '' || model.saveState._tag === 'Saving') {
          return { model }
        }
        return {
          model: { ...model, saveState: Saving.make({ name }) },
          commands: [SaveGreeting({ name })],
        }
      },
      SucceededSaveGreeting: ({ greeting }) => ({
        model: {
          ...model,
          name: '',
          greetings: [greeting, ...model.greetings],
          saveState: Idle.make({}),
        },
      }),
      TickedClock: ({ time }) => ({ model: { ...model, serverTime: time } }),
    }),
  )

// SUBSCRIPTION

export const subscriptions = Subscription.make<Model, Message>()(entry => ({
  clock: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Stream.tick('1 second').pipe(
          Stream.mapEffect(() => Clock.currentTimeMillis),
          Stream.map(millis =>
            Message.TickedClock({
              time: new Date(millis).toISOString().slice(11, 19),
            }),
          ),
        ),
    },
  ),
}))

// VIEW

const greetingForm = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.form(
    [h.OnSubmit(Message.SubmittedGreeting())],
    [
      h.label([h.For('name')], ['Your name']),
      h.input([
        h.Id('name'),
        h.Type('text'),
        h.Value(model.name),
        h.Placeholder('Ada'),
        h.OnInput(name => Message.ChangedName({ name })),
      ]),
      h.button(
        [
          h.Type('submit'),
          h.Disabled(model.name.trim() === '' || model.saveState._tag === 'Saving'),
        ],
        [model.saveState._tag === 'Saving' ? 'Saving...' : 'Save greeting'],
      ),
    ],
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `hyper-effect (${model.count})`,
  body: h.main(
    [],
    [
      h.button([h.AriaLabel('Decrement'), h.OnClick(Message.ClickedDecrement())], ['-']),
      h.span([], [model.count.toString()]),
      h.button([h.AriaLabel('Increment'), h.OnClick(Message.ClickedIncrement())], ['+']),
      greetingForm(model, h),
      h.ul([], model.greetings.map(greeting => h.li([], [greeting]))),
      h.p([], ['Server time ', model.serverTime]),
    ],
  ),
})

export const program: Program<Model, Message, ClientMessage> = {
  name: 'greeter',
  Model,
  ClientMessage,
  flags: () => Effect.void,
  init,
  update,
  view,
  subscriptions,
}
