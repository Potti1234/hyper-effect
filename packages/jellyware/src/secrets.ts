import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

import { Redacted } from 'effect'

/* Secret settings at rest: AES-256-GCM with a key derived from the app's
   secret (`Options.secretKey` of the loader), so the settings store (a file
   in the example) holds no secret in the clear. A stored secret is
   `enc:v1:<iv>:<tag>:<data>`, base64url; an empty string is "not set". */

const PREFIX = 'enc:v1:'

const keyOf = (secret: Redacted.Redacted<string>) =>
  createHash('sha256').update(`jellyware settings\u0000${Redacted.value(secret)}`).digest()

export const encrypt = (secret: Redacted.Redacted<string>, plain: string): string => {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyOf(secret), iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `${PREFIX}${[iv, cipher.getAuthTag(), data].map(part => part.toString('base64url')).join(':')}`
}

/** The plain text; null when it is not a stored secret or the key does not
 *  open it (the key changed). */
export const decrypt = (secret: Redacted.Redacted<string>, stored: string): string | null => {
  if (!stored.startsWith(PREFIX)) return null
  const [iv, tag, data] = stored.slice(PREFIX.length).split(':').map(part => Buffer.from(part, 'base64url'))
  if (iv === undefined || tag === undefined || data === undefined) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyOf(secret), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

export const isStoredSecret = (value: unknown): value is string => typeof value === 'string' && value.startsWith(PREFIX)

/** How a stored secret shows in the history: set, with a short mark of
 *  this ciphertext (a new one for every change; it tells nothing about the
 *  secret), or not set. */
export const maskSecret = (stored: string): string =>
  stored === '' ? '(not set)' : `(secret ${createHash('sha256').update(stored).digest('hex').slice(0, 6)})`
