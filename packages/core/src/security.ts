import { createCipheriv, createDecipheriv, createSecretKey, hkdfSync, randomBytes } from 'node:crypto'

import { Option, Redacted } from 'effect'
import type { HttpServerRequest } from 'effect/http'

/* Request hardening that is independent of sessions: the page's
   Content-Security-Policy, sealed snapshots, client addresses behind
   proxies, and token buckets. */

// CONTENT SECURITY POLICY

export type ContentSecurityPolicy = Readonly<{
  /** Sources added to the defaults, per directive, for what the app loads
   *  itself: `{ 'connect-src': ['https://tiles.example.com'] }`. */
  directives?: Readonly<Record<string, ReadonlyArray<string>>>
  /** Report violations instead of blocking them (`-Report-Only` header). */
  reportOnly?: boolean
}>

/** A fresh nonce for one page response. */
export const makeNonce = (): string => randomBytes(16).toString('base64')

/** The page policy. Scripts and styles come from the page's own origin or
 *  carry the response's nonce (hyper-effect's inline script and style, the
 *  Datastar bundle, the app's module scripts). Datastar evaluates its
 *  `data-*` expressions with `Function`, hence `'unsafe-eval'`; those
 *  expressions are built from tokens and ids only, never from user content
 *  (see `binding.ts`). Style attributes stay allowed, since views and morphs
 *  set them. */
export const contentSecurityPolicy = (
  nonce: string,
  extra: ContentSecurityPolicy['directives'] = {},
): string => {
  const directives: Record<string, Array<string>> = {
    'default-src': ["'self'"],
    'base-uri': ["'none'"],
    'object-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
    'script-src': ["'self'", `'nonce-${nonce}'`, "'unsafe-eval'"],
    'style-src': ["'self'", `'nonce-${nonce}'`],
    'style-src-attr': ["'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'connect-src': ["'self'"],
    'worker-src': ["'self'", 'blob:'],
  }
  for (const [name, sources] of Object.entries(extra)) {
    const current = directives[name] ?? []
    directives[name] = [...current, ...sources.filter(source => !current.includes(source))]
  }
  return Object.entries(directives)
    .map(([name, sources]) => [name, ...sources].join(' '))
    .join('; ')
}

// SEALED SNAPSHOTS

export type Secret = Redacted.Redacted<string> | string

const SEAL_VERSION = 'v1'

/** AES-256-GCM with keys derived (HKDF-SHA256) from the given secrets and a
 *  context string. The first secret seals; every secret opens, so a secret can
 *  be rotated without losing open sessions. `associated` binds a sealed value
 *  to where it is stored: opened under another key it fails. */
export const makeSealer = (secrets: ReadonlyArray<Secret>, context: string) => {
  // Key objects made once: a raw key per cipher costs a key object each time,
  // and with durable events every event seals a snapshot.
  const keys = secrets.map(secret =>
    createSecretKey(
      Buffer.from(
        hkdfSync(
          'sha256',
          Redacted.isRedacted(secret) ? Redacted.value(secret) : secret,
          'hyper-effect',
          context,
          32,
        ),
      ),
    ),
  )
  const [sealingKey] = keys
  if (sealingKey === undefined) {
    throw new Error('makeSealer needs at least one secret')
  }

  const seal = (plaintext: string, associated: string): string => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', sealingKey, iv)
    cipher.setAAD(Buffer.from(associated, 'utf8'))
    const sealed = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ])
    return `${SEAL_VERSION}.${iv.toString('base64url')}.${sealed.toString('base64url')}`
  }

  const open = (value: string, associated: string): Option.Option<string> => {
    const [version, ivPart, sealedPart] = value.split('.')
    if (version !== SEAL_VERSION || ivPart === undefined || sealedPart === undefined) {
      return Option.none()
    }
    const iv = Buffer.from(ivPart, 'base64url')
    const sealed = Buffer.from(sealedPart, 'base64url')
    if (iv.length !== 12 || sealed.length < 16) return Option.none()
    const ciphertext = sealed.subarray(0, sealed.length - 16)
    const tag = sealed.subarray(sealed.length - 16)
    for (const key of keys) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAAD(Buffer.from(associated, 'utf8'))
        decipher.setAuthTag(tag)
        return Option.some(
          Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'),
        )
      } catch {
        // wrong key or tampered: try the next key
      }
    }
    return Option.none()
  }

  return { seal, open }
}

// PROXIES

/** The entry a trusted proxy appended to a comma-separated forwarding header
 *  (`X-Forwarded-For`, `X-Forwarded-Host`). With `trustProxy` proxies in front,
 *  the client-facing one appended the `trustProxy`-th entry from the end; any
 *  entry before it came from the client and can be forged. */
export const forwarded = (
  header: string | undefined,
  trustProxy: number,
): Option.Option<string> => {
  if (trustProxy <= 0 || header === undefined) return Option.none()
  const entries = header
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
  return Option.fromNullishOr(entries[Math.max(0, entries.length - trustProxy)])
}

/** The address a request came from, for per-client limits. */
export const clientAddress = (
  request: HttpServerRequest.HttpServerRequest,
  trustProxy: number,
): string =>
  forwarded(request.headers['x-forwarded-for'], trustProxy).pipe(
    Option.orElse(() => request.remoteAddress),
    Option.getOrElse(() => 'unknown'),
  )

/** The host the browser addressed: the Host header, or the one the client-facing
 *  proxy received when proxies are trusted. */
export const requestHost = (
  request: HttpServerRequest.HttpServerRequest,
  trustProxy: number,
): string | undefined =>
  forwarded(request.headers['x-forwarded-host'], trustProxy).pipe(
    Option.getOrElse(() => request.headers['host']),
  )

/** Requests to a session's endpoints must come from the page's own site. A
 *  cross-site form or fetch carries the victim's cookies, but its Origin (and
 *  Sec-Fetch-Site, where browsers send it) gives it away. Same-origin GETs
 *  carry no Origin. */
export const isSameSite = (
  request: HttpServerRequest.HttpServerRequest,
  allowedOrigins: ReadonlyArray<string>,
  trustProxy: number,
): boolean => {
  const origin = request.headers['origin']
  if (origin !== undefined && allowedOrigins.includes(origin)) return true
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  if (origin === undefined) return true
  try {
    return new URL(origin).host === requestHost(request, trustProxy)
  } catch {
    return false
  }
}

// RATE LIMITS

export type Bucket = { tokens: number; at: number }

export const fullBucket = (burst: number, now: number): Bucket => ({ tokens: burst, at: now })

/** Takes one token, refilling at `rate` per second up to `burst`; false when
 *  the bucket is empty. */
export const take = (bucket: Bucket, rate: number, burst: number, now: number): boolean => {
  bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.at) / 1000) * rate)
  bucket.at = now
  if (bucket.tokens < 1) return false
  bucket.tokens -= 1
  return true
}

/** Whether a bucket untouched since would be full again by `now`. */
export const isRefilled = (bucket: Bucket, rate: number, burst: number, now: number): boolean =>
  bucket.tokens + ((now - bucket.at) / 1000) * rate >= burst
