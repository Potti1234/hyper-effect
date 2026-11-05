import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import type { HtmlBuilder } from 'foldkit/html'

import type { Program } from '@hyper-effect/core'
import { type Binder, renderModel } from '@hyper-effect/core/testing'

import { input } from '@/ui/input'

import { Message, type Model, program } from '@/app/greeter'

/* crease/ui components rendered by the server builder. */

const binder: Binder<Message> = {
  endpoint: '/_hyper/test/s/1',
  bindMessage: message => `m: '${JSON.stringify(message)}'`,
  registerHandler: () => 'a.0',
  registerInput: () => {},
}

const viewProgram = (
  view: (model: Model, h: HtmlBuilder<Message>) => ReturnType<typeof program.view>,
): Program<Model, Message, typeof program.ClientMessage.Type> => ({ ...program, view })

const model = program.init().model

describe('crease on the server', () => {
  it.effect('renders crease components with Datastar bindings', () =>
    Effect.gen(function* () {
      const { html, title } = yield* renderModel(program, model, binder)
      assert.strictEqual(title, 'hyper-effect (0)')
      // crease classes survive server rendering
      assert.include(html, 'data-slot="card"')
      assert.include(html, 'bg-card')
      assert.include(html, 'data-on:click=')
      assert.include(html, 'data-on:submit__prevent=')
      assert.include(html, 'data-bind:_hv-name=""')
      assert.notInclude(html, 'onclick')
    }),
  )

  it.effect('renders a crease input with its label and value', () =>
    Effect.gen(function* () {
      const single = viewProgram((_, h) => ({
        title: 'input',
        body: input(
          {
            id: 'email',
            label: 'Email',
            value: 'a@b.c',
            onInput: name => Message.ChangedName({ name }),
          },
          h,
        ),
      }))
      const { html } = yield* renderModel(single, model, binder)
      assert.include(html, 'for="email"')
      assert.include(html, 'value="a@b.c"')
    }),
  )
})
