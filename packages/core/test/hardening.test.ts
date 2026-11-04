import { afterAll, assert, describe, it } from '@effect/vitest'
import { Context, Effect, Schema as S } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { KeyValueStore } from 'effect/persistence'

import * as Metrics from '../src/metrics'
import { PageRedirect, type Program } from '../src/program'
import type { Options } from '../src/server'
import {
  type Handler,
  makeStore,
  openPage,
  openStream,
  postEvent,
  serve,
  token,
  waitForSnapshot,
} from '../src/testing'

import * as Greeter from './fixtures/greeter'

/* The hardening on top of experiment 2: authentication, the page's
   Content-Security-Policy, per-client page limits, sealed and expiring
   snapshots, and origin checks behind proxies. */

const increment = (q: number) => ({ m: token({ _tag: 'ClickedIncrement' }), q })

const get = (handler: Handler, path: string, headers: Readonly<Record<string, string>> = {}) =>
  handler(new Request(`http://localhost${path}`, { headers }))

const decodeNavigation = (body: string): string | undefined => {
  const encoded = body.match(/hyperNavigate\('([^']*)'\)/)?.[1]
  if (encoded === undefined) throw new Error(`no navigation in ${body}`)
  return encoded === '' ? undefined : JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
}

// AUTHENTICATION

const Message = defineMessageUnion({ ClickedIncrement: {} })
type Message = typeof Message.Type

/** A page for signed-in users only; the "session cookie" is just `user`. */
const members: Program<string, Message, Message, string> = {
  name: 'members',
  Model: S.String,
  ClientMessage: Message,
  flags: ({ cookies, headers, url }) =>
    cookies['user'] === undefined
      ? Effect.fail(new PageRedirect({ location: `/login?next=${encodeURIComponent(url.pathname)}` }))
      : Effect.succeed(`${cookies['user']} on ${headers['user-agent'] ?? 'no agent'}`),
  init: model => ({ model }),
  update: model => ({ model }),
  view: (model, h) => ({
    title: model,
    body: h.button([h.OnClick(Message.ClickedIncrement())], [model]),
  }),
}

const signedIn: Options = {
  principal: ({ cookies }) => Effect.succeed(cookies['user']),
}

describe('authentication', () => {
  const store = makeStore()
  const server = serve(members, signedIn, store)
  afterAll(() => server.dispose())

  /** A visitor cookie plus a signed-in user. */
  const signIn = async (user: string) => {
    const anonymous = await openPage(server.handler)
    return openPage(server.handler, '/', `${anonymous.cookie}; user=${user}`)
  }

  it('gives Flags the cookies and headers, and redirects from them', async () => {
    const anonymous = await get(server.handler, '/')
    assert.strictEqual(anonymous.status, 303)
    assert.strictEqual(anonymous.headers.get('location'), '/login?next=%2F')
    // The visitor cookie is set even on the redirect, so the login keeps it.
    assert.include(anonymous.headers.get('set-cookie') ?? '', 'hyper-visitor=')

    const ada = await get(server.handler, '/', { cookie: 'user=ada', 'user-agent': 'test-agent' })
    assert.strictEqual(ada.status, 200)
    assert.include(await ada.text(), 'ada on test-agent')
  })

  it('binds a session to its principal; another one closes it and reloads the page', async () => {
    const page = await signIn('ada')
    assert.strictEqual((await postEvent(server.handler, page, increment(1))).status, 204)

    // Signed out in another tab: the next event reloads the page instead.
    const signedOut = { ...page, cookie: page.cookie.replace(/; user=ada$/, '') }
    const response = await postEvent(server.handler, signedOut, increment(2))
    assert.strictEqual(response.status, 200)
    assert.strictEqual(response.headers.get('content-type'), 'text/event-stream')
    assert.isUndefined(decodeNavigation(await response.text()))
    // The session is gone, for the old principal too.
    assert.strictEqual((await postEvent(server.handler, page, increment(2))).status, 410)
  })

  it('reloads a stream opened for another principal', async () => {
    const page = await signIn('ada')
    const response = await openStream(server.handler, {
      ...page,
      cookie: page.cookie.replace('user=ada', 'user=bob'),
    })
    assert.strictEqual(response.status, 200)
    assert.isUndefined(decodeNavigation(await response.text()))
  })

  it('sends a live page to the redirect when its session is recreated from the URL', async () => {
    const page = await signIn('ada')
    // A restarted server without snapshots, and the user signed out meanwhile.
    const restarted = serve(members, signedIn, makeStore())
    try {
      const response = await openStream(restarted.handler, {
        ...page,
        cookie: page.cookie.replace(/; user=ada$/, ''),
      })
      assert.strictEqual(decodeNavigation(await response.text()), '/login?next=%2F')
    } finally {
      await restarted.dispose()
    }
  })

  it('keeps the principal in the snapshot', async () => {
    const page = await signIn('ada')
    await postEvent(server.handler, page, increment(1))
    await waitForSnapshot(store, page)
    const restarted = serve(members, signedIn, store)
    try {
      const asBob = { ...page, cookie: page.cookie.replace('user=ada', 'user=bob') }
      const response = await postEvent(restarted.handler, asBob, increment(2))
      assert.isUndefined(decodeNavigation(await response.text()))
    } finally {
      await restarted.dispose()
    }
  })
})

// CONTENT SECURITY POLICY

describe('content security policy', () => {
  const policyOf = async (options: Options) => {
    const server = serve({ ...Greeter.program, name: 'csp' }, options)
    try {
      const response = await get(server.handler, '/')
      return { headers: response.headers, html: await response.text() }
    } finally {
      await server.dispose()
    }
  }

  it('sends a nonce-based policy that covers every script and style hyper-effect emits', async () => {
    const { headers, html } = await policyOf({
      scripts: ['/assets/islands.js'],
      contentSecurityPolicy: { directives: { 'connect-src': ['https://tiles.example.com'] } },
    })
    const policy = headers.get('content-security-policy') ?? ''
    const nonce = policy.match(/'nonce-([^']+)'/)?.[1]
    assert.isDefined(nonce)
    const directive = (name: string) =>
      policy.split('; ').find(entry => entry.startsWith(`${name} `)) ?? ''
    assert.notInclude(directive('script-src'), "'unsafe-inline'")
    assert.include(directive('script-src'), "'unsafe-eval'")
    assert.strictEqual(directive('connect-src'), "connect-src 'self' https://tiles.example.com")
    assert.include(policy, "frame-ancestors 'none'")
    assert.include(policy, "base-uri 'none'")
    // Every script and style element carries this response's nonce.
    const tags = [...html.matchAll(/<(script|style)\b[^>]*>/g)].map(match => match[0])
    assert.lengthOf(tags, 4)
    for (const tag of tags) assert.include(tag, `nonce="${nonce}"`)
    // The Datastar bundle is pinned by Subresource Integrity.
    assert.match(html, /datastar\.js" integrity="sha384-[A-Za-z0-9+/=]+" crossorigin="anonymous"/)
    assert.strictEqual(headers.get('x-content-type-options'), 'nosniff')
  })

  it('uses a new nonce per response', async () => {
    const first = (await policyOf({})).headers.get('content-security-policy')
    const second = (await policyOf({})).headers.get('content-security-policy')
    assert.notStrictEqual(first, second)
  })

  it('can report only, or be turned off', async () => {
    const reporting = await policyOf({ contentSecurityPolicy: { reportOnly: true } })
    assert.isNull(reporting.headers.get('content-security-policy'))
    assert.isNotNull(reporting.headers.get('content-security-policy-report-only'))
    const off = await policyOf({ contentSecurityPolicy: false })
    assert.isNull(off.headers.get('content-security-policy'))
  })

  it('leaves out integrity for a custom Datastar URL unless given', async () => {
    const custom = await policyOf({ datastarUrl: '/datastar.js' })
    assert.notInclude(custom.html, 'integrity=')
  })
})

// PER-CLIENT PAGE LIMITS

describe('page limits per client', () => {
  const limited = (trustProxy: number) =>
    serve(
      { ...Greeter.program, name: `pages-${trustProxy}` },
      { trustProxy, limits: { pagesPerSecond: 0.001, pageBurst: 3 } },
    )

  const statuses = (handler: Handler, count: number, forwardedFor: string) =>
    Promise.all(
      Array.from({ length: count }, () =>
        get(handler, '/', { 'x-forwarded-for': forwardedFor }).then(response => response.status),
      ),
    )

  it('limits page loads per client address, read from the trusted proxy', async () => {
    const server = limited(1)
    try {
      assert.deepStrictEqual(await statuses(server.handler, 5, '203.0.113.1'), [200, 200, 200, 429, 429])
      // Another client is unaffected.
      assert.deepStrictEqual(await statuses(server.handler, 1, '203.0.113.2'), [200])
      // Entries before the proxy's own are the client's and can be forged.
      assert.deepStrictEqual(await statuses(server.handler, 1, '198.51.100.9, 203.0.113.1'), [429])
    } finally {
      await server.dispose()
    }
  })

  it('ignores X-Forwarded-For without trusted proxies', async () => {
    const server = limited(0)
    try {
      const results = [
        ...(await statuses(server.handler, 3, '203.0.113.1')),
        ...(await statuses(server.handler, 1, '203.0.113.2')),
      ]
      assert.deepStrictEqual(results, [200, 200, 200, 429])
    } finally {
      await server.dispose()
    }
  })

  it('counts sessions recreated from a URL, and keeps them within the visitor cap', async () => {
    const name = 'recreate'
    const server = serve({ ...Greeter.program, name }, { limits: { sessionsPerVisitor: 2 } })
    try {
      const page = await openPage(server.handler)
      for (let index = 0; index < 5; index += 1) {
        const response = await openStream(server.handler, { ...page, sessionId: crypto.randomUUID() })
        await response.body?.cancel()
      }
      assert.isAtMost(Metrics.snapshot().programs[name]?.sessions ?? 0, 2)
    } finally {
      await server.dispose()
    }
  })
})

// SNAPSHOTS

describe('snapshots', () => {
  const name = 'sealed'
  const program = { ...Greeter.program, name }
  const store = makeStore()
  const raw = Context.get(store, KeyValueStore.KeyValueStore)
  const read = (id: string) => Effect.runPromise(raw.get(`hyper/${name}/${id}`))
  const write = (id: string, value: string) => Effect.runPromise(raw.set(`hyper/${name}/${id}`, value))

  const restoresWith = async (options: Options, page: Parameters<typeof postEvent>[1]) => {
    const restarted = serve(program, options, store)
    try {
      return (await postEvent(restarted.handler, page, increment(2))).status
    } finally {
      await restarted.dispose()
    }
  }

  it('are sealed, bound to their session, rotatable, and expire', async () => {
    const server = serve(program, { snapshotSecret: 'first secret' }, store)
    try {
      const page = await openPage(server.handler)
      const other = await openPage(server.handler, '/', page.cookie)
      await postEvent(server.handler, page, increment(1))
      await waitForSnapshot(store, page)
      // The other page's own snapshot must not land after the swap below.
      await waitForSnapshot(store, other)

      const sealed = (await read(page.sessionId)) ?? ''
      assert.match(sealed, /^v1\.[\w-]+\.[\w-]+$/)
      assert.notInclude(sealed, 'count')
      assert.notInclude(sealed, page.cookie.split('=')[1] ?? 'visitor')

      // Refused: another secret, no secret, an expired snapshot.
      assert.strictEqual(await restoresWith({ snapshotSecret: 'another secret' }, page), 410)
      assert.strictEqual(await restoresWith({}, page), 410)
      await new Promise(resolve => setTimeout(resolve, 20))
      assert.strictEqual(
        await restoresWith({ snapshotSecret: 'first secret', snapshotTtl: '10 millis' }, page),
        410,
      )
      // Refused: tampered, or moved to another session's key.
      await write(other.sessionId, sealed)
      assert.strictEqual(await restoresWith({ snapshotSecret: 'first secret' }, other), 410)
      const flipped = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'B' : 'A') + sealed.slice(-1)
      await write(page.sessionId, flipped)
      assert.strictEqual(await restoresWith({ snapshotSecret: 'first secret' }, page), 410)

      // Restored: a rotated secret list still opens it.
      await write(page.sessionId, sealed)
      assert.strictEqual(
        await restoresWith({ snapshotSecret: ['new secret', 'first secret'] }, page),
        204,
      )
    } finally {
      await server.dispose()
    }
  })

  it('never accept a plain snapshot once a secret is set', async () => {
    const plainName = 'downgrade'
    const plainProgram = { ...Greeter.program, name: plainName }
    const plainStore = makeStore()
    const server = serve(plainProgram, {}, plainStore)
    try {
      const page = await openPage(server.handler)
      await postEvent(server.handler, page, increment(1))
      await waitForSnapshot(plainStore, page)
      const restarted = serve(plainProgram, { snapshotSecret: 'secret' }, plainStore)
      try {
        assert.strictEqual((await postEvent(restarted.handler, page, increment(2))).status, 410)
      } finally {
        await restarted.dispose()
      }
    } finally {
      await server.dispose()
    }
  })
})

// PROXIES

describe('origin checks behind proxies', () => {
  const server = serve({ ...Greeter.program, name: 'proxied' }, { trustProxy: 1 })
  const direct = serve({ ...Greeter.program, name: 'direct' })
  afterAll(() => Promise.all([server.dispose(), direct.dispose()]))

  const fromBrowser = { origin: 'https://app.example', 'x-forwarded-host': 'app.example' }

  it('compares the Origin with the host the proxy received', async () => {
    const page = await openPage(server.handler)
    assert.strictEqual((await postEvent(server.handler, page, increment(1), fromBrowser)).status, 204)
    const crossSite = { ...fromBrowser, origin: 'https://evil.example' }
    assert.strictEqual((await postEvent(server.handler, page, increment(2), crossSite)).status, 403)
  })

  it('ignores X-Forwarded-Host without trusted proxies', async () => {
    const page = await openPage(direct.handler)
    assert.strictEqual((await postEvent(direct.handler, page, increment(1), fromBrowser)).status, 403)
  })

  it('refuses requests the browser marks cross-site', async () => {
    const page = await openPage(direct.handler)
    const headers = { 'sec-fetch-site': 'cross-site' }
    assert.strictEqual((await postEvent(direct.handler, page, increment(1), headers)).status, 403)
    assert.strictEqual((await openStream(direct.handler, page, headers)).status, 403)
  })
})
