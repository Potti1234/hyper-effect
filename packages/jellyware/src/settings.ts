import { Context, Effect, Redacted, Schema as S, Stream } from 'effect'

/* Settings of an extension: declared in its extension.json, stored by the
   app (the loader keeps them in the app's KeyValueStore), and given to the
   extension's layer as `ExtensionSettings` when it is built.

   A change of settings loads the extension again with the new values, the
   way a change of its files does: the new version is mounted next to the
   running one and replaces it only once it is built. A value the extension
   fails with leaves the running version in place, and the loader puts the
   old values back (see `Extensions.configure`).

   Two kinds need more than that:
   - Secret settings (`type: "secret"`), such as a key for another service,
     are stored encrypted, given to the extension as `Redacted` values, and
     shown everywhere else only as set or not set: in the browser, the
     history, the agent's guide. Extension files hold no values, so the
     agent's copy of them has none either.
   - Member settings (`scope: "member"`): the administrator's value is the
     default, and every member may set their own. A member's change does
     not build the extension again; the extension reads the values of the
     member it serves while it runs (`forMember`). */

const common = {
  label: S.String,
  description: S.optional(S.String),
  /** `member`: every member may set their own value; the stored value is
   *  the default. Not for secrets. Default `app`. */
  scope: S.optional(S.Literals(['app', 'member'])),
}

export const SettingSpec = S.Union([
  S.Struct({ type: S.Literal('string'), default: S.String, ...common }),
  S.Struct({ type: S.Literal('number'), default: S.Number, min: S.optional(S.Number), max: S.optional(S.Number), ...common }),
  S.Struct({ type: S.Literal('boolean'), default: S.Boolean, ...common }),
  S.Struct({ type: S.Literal('select'), default: S.String, options: S.Array(S.String), ...common }),
  S.Struct({ type: S.Literal('secret'), ...common }),
])
export type SettingSpec = typeof SettingSpec.Type

export type SettingValue = string | number | boolean

const isSettingValue = (value: unknown): value is SettingValue =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

/** Whether a setting is per member. Secrets never are. */
export const isMemberSetting = (spec: SettingSpec): boolean => spec.scope === 'member' && spec.type !== 'secret'

const defaultOf = (spec: SettingSpec): SettingValue => ('default' in spec ? spec.default : '')

/** One setting as the workshop shows it: its declaration and its value. A
 *  secret's value is always empty; `isSet` says whether it has one. */
export const SettingField = S.Struct({
  key: S.String,
  spec: SettingSpec,
  value: S.Union([S.String, S.Number, S.Boolean]),
  isSet: S.Boolean.pipe(S.withDecodingDefaultKey(Effect.succeed(true))),
})
export type SettingField = typeof SettingField.Type

/** The values in effect: stored ones that fit their declaration, defaults
 *  for the rest. Stored values of keys no longer declared are left out. */
export const effectiveValues = (
  specs: Readonly<Record<string, SettingSpec>>,
  stored: Readonly<Record<string, unknown>>,
): Readonly<Record<string, SettingValue>> =>
  Object.fromEntries(
    Object.entries(specs).map(([key, spec]) => {
      const value = stored[key]
      return [key, fits(spec, value) === null && isSettingValue(value) ? value : defaultOf(spec)]
    }),
  )

/** Why `value` does not fit `spec`, or null when it does. */
export const fits = (spec: SettingSpec, value: unknown): string | null => {
  switch (spec.type) {
    case 'string':
    case 'secret':
      return typeof value === 'string' ? null : 'must be text'
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be on or off'
    case 'select':
      return typeof value === 'string' && spec.options.includes(value) ? null : `must be one of ${spec.options.join(', ')}`
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number'
      if (spec.min !== undefined && value < spec.min) return `must be at least ${spec.min}`
      if (spec.max !== undefined && value > spec.max) return `must be at most ${spec.max}`
      return null
  }
}

/** Reads the form's text for each declared key as a value of its type, or
 *  answers with what is wrong. Keys not declared are refused. A secret left
 *  empty is left out (it keeps its value). */
export const parseInput = (
  specs: Readonly<Record<string, SettingSpec>>,
  input: Readonly<Record<string, string>>,
): { values: Readonly<Record<string, SettingValue>> } | { errors: ReadonlyArray<string> } => {
  const errors: Array<string> = []
  const values: Record<string, SettingValue> = {}
  for (const key of Object.keys(input)) {
    if (!(key in specs)) errors.push(`"${key}" is not a setting of this extension.`)
  }
  for (const [key, spec] of Object.entries(specs)) {
    const text = input[key]
    if (text === undefined) continue
    if (spec.type === 'secret' && text === '') continue
    const value: SettingValue =
      spec.type === 'number' ? (text.trim() === '' ? Number.NaN : Number(text)) : spec.type === 'boolean' ? text === 'true' : text
    const problem = fits(spec, value)
    if (problem !== null) errors.push(`${spec.label} ${problem}.`)
    else values[key] = value
  }
  return errors.length > 0 ? { errors } : { values }
}

/** Typed reads of a set of values. */
export type SettingValues = Readonly<{
  values: Readonly<Record<string, SettingValue>>
  string: (key: string) => string
  number: (key: string) => number
  boolean: (key: string) => boolean
}>

export const valuesOf = (values: Readonly<Record<string, SettingValue>>): SettingValues => ({
  values,
  string: key => (typeof values[key] === 'string' ? values[key] : ''),
  number: key => (typeof values[key] === 'number' ? values[key] : 0),
  boolean: key => values[key] === true,
})

/** The settings an extension was built with. Read them while building:
 *  a change builds the extension again. `values` and the typed reads hold
 *  no secrets; `secret` gives one as `Redacted` (`Redacted.value` reads it;
 *  logged or printed, it shows as `<redacted>`). */
export class ExtensionSettings extends Context.Service<
  ExtensionSettings,
  SettingValues & {
    readonly secret: (key: string) => Redacted.Redacted<string>
    /** Whether a secret has a value. */
    readonly hasSecret: (key: string) => boolean
    /** The values for one member, now and after every change of theirs:
     *  their own for member settings, the others as above. */
    readonly forMember: (memberId: string) => Stream.Stream<SettingValues>
  }
>()('@hyper-effect/jellyware/ExtensionSettings') {}

export const makeSettings = (
  values: Readonly<Record<string, SettingValue>>,
  secrets: Readonly<Record<string, string>> = {},
  forMember: (memberId: string) => Stream.Stream<SettingValues> = () => Stream.succeed(valuesOf(values)),
) =>
  ExtensionSettings.of({
    ...valuesOf(values),
    secret: key => Redacted.make(secrets[key] ?? ''),
    hasSecret: key => (secrets[key] ?? '') !== '',
    forMember,
  })

