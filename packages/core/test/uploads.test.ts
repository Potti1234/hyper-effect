import { afterAll, assert, describe, it } from '@effect/vitest'
import { Effect, Schema as S } from 'effect'
import { Command } from 'foldkit'
import * as FoldkitFile from 'foldkit/file'
import { defineMessageUnion } from 'foldkit/message'

import type { Program } from '../src/program'
import { type Page, openPage, openStream, readUntil, serve } from '../src/testing'

/* Uploads: `OnFileChange` and `OnDropFiles` on the server. */

const Model = S.Struct({ names: S.Array(S.String), text: S.String })
type Model = typeof Model.Type

const Message = defineMessageUnion({
  ChoseFiles: { files: S.Array(FoldkitFile.File) },
  ReadFile: { text: S.String },
  FailedRead: {},
})
type Message = typeof Message.Type
const ClientMessage = S.Union([Message.FailedRead])

// Read with Foldkit's own helper, as a browser app would.
const ReadText = Command.define('ReadText', {
  args: { file: FoldkitFile.File },
  messages: [Message.ReadFile, Message.FailedRead],
  execute: ({ file }) =>
    FoldkitFile.readAsText(file).pipe(
      Effect.map(text => Message.ReadFile({ text })),
      Effect.orElseSucceed(() => Message.FailedRead()),
    ),
})

const program: Program<Model, Message, typeof ClientMessage.Type> = {
  name: 'uploads',
  Model,
  ClientMessage,
  flags: () => Effect.void,
  init: () => ({ model: { names: [], text: '' } }),
  update: (model, message) => {
    switch (message._tag) {
      case 'ChoseFiles':
        return {
          model: { ...model, names: message.files.map(file => `${file.name} (${file.type}, ${file.size} B)`) },
          commands: message.files.slice(0, 1).map(file => ReadText({ file })),
        }
      case 'ReadFile':
        return { model: { ...model, text: message.text } }
      case 'FailedRead':
        return { model: { ...model, text: 'failed' } }
    }
  },
  view: (model, h) => ({
    title: 'uploads',
    body: h.div(
      [],
      [
        h.input([h.Id('picker'), h.Type('file'), h.OnFileChange(files => Message.ChoseFiles({ files }))]),
        h.div([h.Id('zone'), h.AllowDrop(), h.OnDropFiles(files => Message.ChoseFiles({ files }))], ['Drop here']),
        h.ul([], model.names.map(name => h.li([], [name]))),
        h.pre([], [model.text]),
      ],
    ),
  }),
}

const server = serve(program, { limits: { maxUploadFiles: 2, maxUploadBytes: 64 * 1024 } })
afterAll(() => server.dispose())

const handlerOf = (html: string, event: string) =>
  html.match(new RegExp(`data-on:${event}="window\\.hyperUpload\\?\\.\\(el, [^,]+, \\{h: '([^']+)'\\}`))?.[1] ?? ''

const upload = (
  page: Page,
  handlerId: string,
  files: ReadonlyArray<File>,
  options: Readonly<{ q?: number; headers?: Readonly<Record<string, string>> }> = {},
) => {
  const body = new FormData()
  body.set('h', handlerId)
  body.set('q', String(options.q ?? 1))
  body.set('p', '{}')
  for (const file of files) body.append('f', file, file.name)
  return server.handler(
    new Request(`http://localhost/_hyper/${page.program}/s/${page.sessionId}/upload`, {
      method: 'POST',
      headers: { 'datastar-request': 'true', cookie: page.cookie, ...options.headers },
      body,
    }),
  )
}

const textFile = (text: string, name = 'note.txt') => new File([text], name, { type: 'text/plain' })

describe('uploads', () => {
  it('bind file inputs and drop zones to the page script, in event order', async () => {
    const page = await openPage(server.handler)
    assert.match(page.html, /data-on:change="window\.hyperUpload\?\.\(el, evt\.target\.files, \{h: '[\w-]+\.\w+'\}, \+\+\$_hq, \$_he\)"/)
    assert.match(page.html, /data-on:drop__prevent="window\.hyperUpload\?\.\(el, evt\.dataTransfer\?\.files, /)
    assert.include(page.html, 'data-on:dragover__prevent')
  })

  it('reach update as web Files that Foldkit helpers can read', async () => {
    const page = await openPage(server.handler)
    const response = await upload(page, handlerOf(page.html, 'change'), [textFile('hello from a file')])
    assert.strictEqual(response.status, 204)
    const stream = await openStream(server.handler, page)
    const text = await readUntil(stream, 'hello from a file')
    assert.include(text, 'note.txt (text/plain, 17 B)')
    assert.include(text, 'hello from a file')
  })

  it('work for dropped files too', async () => {
    const page = await openPage(server.handler)
    const response = await upload(page, handlerOf(page.html, 'drop__prevent'), [textFile('dropped', 'drop.txt')])
    assert.strictEqual(response.status, 204)
    assert.include(await readUntil(await openStream(server.handler, page), 'dropped</pre>'), 'drop.txt')
  })

  it('are refused beyond the limits, and from anyone but the page owner', async () => {
    const page = await openPage(server.handler)
    const handlerId = handlerOf(page.html, 'change')
    const three = [textFile('a', 'a.txt'), textFile('b', 'b.txt'), textFile('c', 'c.txt')]
    assert.strictEqual((await upload(page, handlerId, three)).status, 413)
    const huge = new File([new Uint8Array(128 * 1024)], 'huge.bin')
    assert.include([400, 413], (await upload(page, handlerId, [huge])).status)
    const stranger = await openPage(server.handler)
    assert.strictEqual((await upload({ ...page, cookie: stranger.cookie }, handlerId, [textFile('x')])).status, 403)
    assert.strictEqual(
      (await upload(page, handlerId, [textFile('x')], { headers: { 'datastar-request': 'false' } })).status,
      403,
    )
    assert.strictEqual(
      (await upload(page, handlerId, [textFile('x')], { headers: { origin: 'https://evil.example' } })).status,
      403,
    )
  })
})

describe('the server FileReader', () => {
  it('reads text, data URLs and bytes the way Foldkit expects', async () => {
    const file = new File(['hi'], 'hi.txt', { type: 'text/plain' })
    assert.strictEqual(await Effect.runPromise(FoldkitFile.readAsText(file)), 'hi')
    assert.strictEqual(await Effect.runPromise(FoldkitFile.readAsDataUrl(file)), 'data:text/plain;base64,aGk=')
    const bytes = await Effect.runPromise(FoldkitFile.readAsArrayBuffer(file))
    assert.deepStrictEqual([...new Uint8Array(bytes)], [104, 105])
  })
})
