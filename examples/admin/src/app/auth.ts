import { createHmac, timingSafeEqual } from 'node:crypto'

import { Effect, Layer, Schema as S } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

import { PageRedirect, type PageRequest, type RequestContext, secretFromEnvironment } from '@hyper-effect/core'

/* Demo sign-in: two seeded users, no passwords. An editor may change the
   catalog, a viewer may only look. The name travels in an HMAC-signed,
   HttpOnly cookie; Flags read it, `principal` binds sessions to it, and
   update re-checks the role before every write (the browser cannot forge a
   Message that is not a ClientMessage, but a viewer could still post one). A
   real app verifies a session against its identity provider here. */

export const Role = S.Literals(['editor', 'viewer'])
export type Role = typeof Role.Type

export const User = S.Struct({ name: S.String, role: Role })
export type User = typeof User.Type

export const USERS: ReadonlyArray<User> = [
  { name: 'ada', role: 'editor' },
  { name: 'grace', role: 'viewer' },
]

export const canEdit = (user: User): boolean => user.role === 'editor'

const USER_COOKIE = 'admin-user'
const SECRET = secretFromEnvironment('ADMIN_SECRET', 'admin-dev-secret, set ADMIN_SECRET')
const MAX_AGE = 60 * 60 * 12

const signature = (name: string) => createHmac('sha256', SECRET).update(name).digest()

const cookieValue = (name: string) =>
  `${Buffer.from(name, 'utf8').toString('base64url')}.${signature(name).toString('base64url')}`

/** The signed-in user, if the cookie is valid and the user still exists. */
export const signedInUser = (cookies: RequestContext['cookies']): User | undefined => {
  const [encodedName, encodedSignature] = (cookies[USER_COOKIE] ?? '').split('.')
  if (encodedName === undefined || encodedSignature === undefined) return undefined
  const name = Buffer.from(encodedName, 'base64url').toString('utf8')
  const expected = signature(name)
  const actual = Buffer.from(encodedSignature, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined
  return USERS.find(user => user.name === name)
}

/** Hyper.layer's `principal`: sessions belong to the signed-in user. */
export const principal = ({ cookies }: RequestContext) =>
  Effect.succeed(signedInUser(cookies)?.name)

/** For Flags: the signed-in user, or a redirect to /login and back. */
export const requireUser = ({ cookies, url }: PageRequest) => {
  const user = signedInUser(cookies)
  return user === undefined
    ? Effect.fail(new PageRedirect({ location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` }))
    : Effect.succeed(user)
}

const safeNext = (next: string | null): string =>
  next !== null && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/products'

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const loginPage = (next: string, error: string | undefined) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Catalog admin</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body class="flex min-h-screen items-center justify-center bg-muted/40 p-4">
<form method="post" action="/login" class="flex w-full max-w-sm flex-col gap-4 rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
<div class="flex flex-col gap-1">
<h1 class="text-lg font-semibold">Catalog admin</h1>
<p class="text-sm text-muted-foreground">Demo users: <b>ada</b> (editor) and <b>grace</b> (viewer).</p>
</div>
<input type="hidden" name="next" value="${escapeHtml(next)}">
<label for="name" class="text-sm font-medium">User</label>
<input id="name" name="name" required maxlength="32" autocomplete="username" autofocus class="h-9 rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
${error === undefined ? '' : `<p class="text-sm text-destructive">${escapeHtml(error)}</p>`}
<button type="submit" class="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">Sign in</button>
</form>
</body>
</html>`

const html = (body: string, status = 200) =>
  HttpServerResponse.text(body, {
    status,
    contentType: 'text/html',
    headers: { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'; form-action 'self'" },
  })

/** Sign-in and sign-out posts must come from this site. */
const isSameOrigin = (request: HttpServerRequest.HttpServerRequest) => {
  const origin = request.headers['origin']
  if (origin === undefined) return request.headers['sec-fetch-site'] !== 'cross-site'
  try {
    return new URL(origin).host === request.headers['host']
  } catch {
    return false
  }
}

const cookie = (request: HttpServerRequest.HttpServerRequest, value: string, maxAge: number) =>
  `${USER_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax; HttpOnly${
    request.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
  }`

export const routes = Layer.mergeAll(
  HttpRouter.add(
    'GET',
    '/login',
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const next = safeNext(new URL(request.url, 'http://localhost').searchParams.get('next'))
      return html(loginPage(next, undefined))
    }),
  ),
  HttpRouter.add(
    'POST',
    '/login',
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (!isSameOrigin(request)) return HttpServerResponse.empty({ status: 403 })
      const form = new URLSearchParams(yield* request.text)
      const name = (form.get('name') ?? '').trim().toLowerCase()
      const next = safeNext(form.get('next'))
      if (!USERS.some(user => user.name === name)) {
        return html(loginPage(next, 'Unknown user. Try ada or grace.'), 400)
      }
      return HttpServerResponse.redirect(next, { status: 303 }).pipe(
        HttpServerResponse.setHeader('set-cookie', cookie(request, cookieValue(name), MAX_AGE)),
      )
    }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 400 })))),
  ),
  HttpRouter.add(
    'POST',
    '/logout',
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (!isSameOrigin(request)) return HttpServerResponse.empty({ status: 403 })
      return HttpServerResponse.redirect('/login', { status: 303 }).pipe(
        HttpServerResponse.setHeader('set-cookie', cookie(request, '', 0)),
      )
    }),
  ),
)
