import { Context, Schema as S } from 'effect'

/* Settings of an extension: declared in its extension.json, stored by the
   app (the loader keeps them in the app's KeyValueStore), and given to the
   extension's layer as `ExtensionSettings` when it is built.

   A change of settings loads the extension again with the new values, the
   way a change of its files does: the new version is mounted next to the
   running one and replaces it only once it is built. A value the extension
   fails with leaves the running version in place, and the loader puts the
   old values back (see `Extensions.configure`). */

const common = { label: S.String, description: S.optional(S.String) }

export const SettingSpec = S.Union([
  S.Struct({ type: S.Literal('string'), default: S.String, ...common }),
  S.Struct({ type: S.Literal('number'), default: S.Number, min: S.optional(S.Number), max: S.optional(S.Number), ...common }),
  S.Struct({ type: S.Literal('boolean'), default: S.Boolean, ...common }),
  S.Struct({ type: S.Literal('select'), default: S.String, options: S.Array(S.String), ...common }),
])
export type SettingSpec = typeof SettingSpec.Type

export type SettingValue = string | number | boolean

const isSettingValue = (value: unknown): value is SettingValue =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

/** One setting as the workshop shows it: its declaration and its value. */
export const SettingField = S.Struct({
  key: S.String,
  spec: SettingSpec,
  value: S.Union([S.String, S.Number, S.Boolean]),
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
      return [key, fits(spec, value) === null && isSettingValue(value) ? value : spec.default]
    }),
  )

/** Why `value` does not fit `spec`, or null when it does. */
export const fits = (spec: SettingSpec, value: unknown): string | null => {
  switch (spec.type) {
    case 'string':
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
 *  answers with what is wrong. Keys not declared are refused. */
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
    const value: SettingValue =
      spec.type === 'number' ? (text.trim() === '' ? Number.NaN : Number(text)) : spec.type === 'boolean' ? text === 'true' : text
    const problem = fits(spec, value)
    if (problem !== null) errors.push(`${spec.label} ${problem}.`)
    else values[key] = value
  }
  return errors.length > 0 ? { errors } : { values }
}

/** The settings an extension was built with. Read them while building:
 *  a change builds the extension again. */
export class ExtensionSettings extends Context.Service<
  ExtensionSettings,
  {
    readonly values: Readonly<Record<string, SettingValue>>
    readonly string: (key: string) => string
    readonly number: (key: string) => number
    readonly boolean: (key: string) => boolean
  }
>()('@hyper-effect/jellyware/ExtensionSettings') {}

export const makeSettings = (values: Readonly<Record<string, SettingValue>>) =>
  ExtensionSettings.of({
    values,
    string: key => (typeof values[key] === 'string' ? values[key] : ''),
    number: key => (typeof values[key] === 'number' ? values[key] : 0),
    boolean: key => values[key] === true,
  })
