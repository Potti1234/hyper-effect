import { Equal } from 'effect'

/* Deps of `region` and `shared` are Model data, compared by value. References
   would not do: Foldkit's Message constructors copy their payload, so data
   arriving through a Message (a store change, a Subscription) is new objects
   every time, equal or not. The same reference still short-circuits, so
   unchanged parts of the Model cost one comparison each. */

const isPlainObject = (value: object): value is Readonly<Record<string, unknown>> => {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Structural equality for Model data. Arrays, plain objects and dates are
 *  walked directly (Effect's `Equal.equals` would hash them first, which costs
 *  more on every render); other values (Option, Data classes) use `Equal`. */
export const equalValues = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let index = 0; index < a.length; index += 1) {
      if (!equalValues(a[index], b[index])) return false
    }
    return true
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a)
    if (keys.length !== Object.keys(b).length) return false
    for (const key of keys) {
      if (!Object.hasOwn(b, key) || !equalValues(a[key], b[key])) return false
    }
    return true
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  }
  return Equal.equals(a, b)
}

export const sameDeps = (a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): boolean =>
  a.length === b.length && a.every((value, index) => equalValues(value, b[index]))
