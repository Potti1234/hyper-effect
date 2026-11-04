import { createHmac, timingSafeEqual } from 'node:crypto'

import { Effect, Layer } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

import { PageRedirect, type PageRequest, type RequestContext } from '@hyper-effect/core'

/* Demo sign-in: any name, no password. The name travels in an HMAC-signed,
   HttpOnly cookie:
   - Flags read it (`requireUser`), so a signed-out visit goes to /login;
   - `principal` binds every session to it, so signing out ends the page.
   A real app verifies its own session or token here instead; keep the same
   three exports. */

const USER_COOKIE = 'starter-user'
const SECRET = process.env['APP_SECRET'] ?? 'dev-secret, set APP_SECRET'
const MAX_AGE = 60 * 60 * 12

const signature = (name: string) => createHmac('sha256', SECRET).update(name).digest()

/** The cookie value for a signed-in user (exported for tests). */
export const cookieValue = (name: string) =>
  `${Buffer.from(name, 'utf8').toString('base64url')}.${signature(name).toString('base64url')}`

/** The signed-in user's name, if the cookie is valid. */
export const signedInUser = (cookies: RequestContext['cookies']): string | undefined => {
  const [encodedName, encodedSignature] = (cookies[USER_COOKIE] ?? '').split('.')
  if (encodedName === undefined || encodedSignature === undefined) return undefined
  const name = Buffer.from(encodedName, 'base64url').toString('utf8')
  const expected = signature(name)
  const actual = Buffer.from(encodedSignature, 'base64url')
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? name : undefined
}

/** For `Hyper.layer`: sessions belong to the signed-in user. */
export const principal = ({ cookies }: RequestContext) => Effect.succeed(signedInUser(cookies))

/** For Flags: the signed-in user, or a redirect to /login and back. */
export const requireUser = ({ cookies, url }: PageRequest) => {
  const user = signedInUser(cookies)
  return user === undefined
    ? Effect.fail(new PageRedirect({ location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` }))
    : Effect.succeed(user)
}

export const USER_COOKIE_NAME = USER_COOKIE

const safeNext = (next: string | null): string =>
  next !== null && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/'

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const loginPage = (next: string, error: string | undefined) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Starter</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body class="flex min-h-screen items-center justify-center bg-muted/40 p-4">
<form method="post" action="/login" class="flex w-full max-w-sm flex-col gap-4 rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
<h1 class="text-lg font-semibold">Starter</h1>
<input type="hidden" name="next" value="${escapeHtml(next)}">
<label for="name" class="text-sm font-medium">Your name</label>
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
      return html(loginPage(safeNext(new URL(request.url, 'http://localhost').searchParams.get('next')), undefined))
    }),
  ),
  HttpRouter.add(
    'POST',
    '/login',
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (!isSameOrigin(request)) return HttpServerResponse.empty({ status: 403 })
      const form = new URLSearchParams(yield* request.text)
      const name = (form.get('name') ?? '').trim()
      const next = safeNext(form.get('next'))
      if (name.length === 0 || name.length > 32) return html(loginPage(next, 'Enter a name of up to 32 characters.'), 400)
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
