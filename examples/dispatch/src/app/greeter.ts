import { Clock, Effect, Match as M, Schema as S, Stream } from 'effect'
import { Command } from 'foldkit'
import type { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { Subscription } from 'foldkit'
import type { Update } from 'foldkit'

import type { Program } from '@hyper-effect/core'
import { badge } from '@/ui/badge'
import { button } from '@/ui/button'
import {
  card,
  cardContent,
  cardDescription,
  cardFooter,
  cardHeader,
  cardTitle,
} from '@/ui/card'
import { input } from '@/ui/input'

/* The spike's demo program. It is an ordinary Foldkit program (Model,
   Message, update, view, Command, Subscription) built from crease/ui
   components; only the runtime underneath is hyper-effect's. */

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

const counter = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex items-center gap-3')],
    [
      button(
        { children: ['-'], variant: 'outline', size: 'icon', ariaLabel: 'Decrement', onClick: Message.ClickedDecrement() },
        h,
      ),
      h.span(
        [h.Class('min-w-12 text-center text-2xl font-semibold tabular-nums')],
        [model.count.toString()],
      ),
      button(
        { children: ['+'], variant: 'outline', size: 'icon', ariaLabel: 'Increment', onClick: Message.ClickedIncrement() },
        h,
      ),
    ],
  )

const greetingForm = (model: Model, h: HtmlBuilder<Message>): Html => {
  const isSaving = model.saveState._tag === 'Saving'
  return h.form(
    [h.Class('grid gap-3'), h.OnSubmit(Message.SubmittedGreeting())],
    [
      input(
        {
          id: 'name',
          label: 'Your name',
          description: 'Sent to the server as you type, debounced by 200 ms.',
          value: model.name,
          placeholder: 'Ada',
          onInput: name => Message.ChangedName({ name }),
        },
        h,
      ),
      button(
        {
          children: ['Save greeting'],
          type: 'submit',
          isLoading: isSaving,
          loadingContent: ['Saving...'],
          isDisabled: model.name.trim() === '',
        },
        h,
      ),
    ],
  )
}

const greetingList = (model: Model, h: HtmlBuilder<Message>): Html =>
  model.greetings.length === 0
    ? h.p([h.Class('text-sm text-muted-foreground')], ['No greetings yet.'])
    : h.ul(
        [h.Class('grid gap-1 text-sm')],
        model.greetings.map(greeting => h.li([], [greeting])),
      )

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `hyper-effect (${model.count})`,
  body: h.main(
    [h.Class('mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-6')],
    [
      card(
        {
          children: [
            cardHeader(
              {
                children: [
                  cardTitle({ children: ['hyper-effect spike'] }, h),
                  cardDescription(
                    {
                      children: [
                        'Foldkit view, crease/ui components, update loop on the server, Datastar in the browser.',
                      ],
                    },
                    h,
                  ),
                ],
              },
              h,
            ),
            cardContent(
              {
                class: 'grid gap-6',
                children: [counter(model, h), greetingForm(model, h), greetingList(model, h)],
              },
              h,
            ),
            cardFooter(
              {
                class: 'justify-between text-sm text-muted-foreground',
                children: [
                  'Server time',
                  badge({ children: [model.serverTime], variant: 'secondary' }, h),
                ],
              },
              h,
            ),
          ],
        },
        h,
      ),
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
