import { assert, describe, it } from '@effect/vitest'
import { Layer, Stream } from 'effect'

import { StylesheetChanges } from '../src/server'
import { openPage, openStream, readUntil, serve } from '../src/testing'

import { program } from './fixtures/greeter'

/* StylesheetChanges: open pages switch stylesheets when the app's CSS is
   rebuilt while the server runs. */

describe('stylesheet changes', () => {
  it('marks the page’s stylesheets as replaceable and sends new ones on the stream', async () => {
    const served = serve(
      { ...program, name: 'styled' },
      { stylesheets: ['/styles.css'] },
      undefined,
      Layer.succeed(StylesheetChanges, Stream.make(['/styles.css?v=2'])),
    )
    try {
      const page = await openPage(served.handler)
      assert.include(page.html, '<link rel="stylesheet" href="/styles.css" data-hyper-style>')
      assert.include(page.html, 'window.hyperStyles?.($_hs)')
      const stream = await openStream(served.handler, page)
      const events = await readUntil(stream, 'styles.css?v=2')
      assert.include(events, 'datastar-patch-signals')
      assert.include(events, '_hs')
    } finally {
      await served.dispose()
    }
  })

  it('sends nothing when the app provides no changes', async () => {
    const served = serve({ ...program, name: 'plain' }, { stylesheets: ['/styles.css'] })
    try {
      const page = await openPage(served.handler)
      const stream = await openStream(served.handler, page)
      const events = await readUntil(stream, 'hyper-effect (0)')
      assert.notInclude(events, '_hs')
    } finally {
      await served.dispose()
    }
  })
})
