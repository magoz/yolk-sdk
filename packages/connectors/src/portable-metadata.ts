import { Effect, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import * as SchemaIssue from 'effect/SchemaIssue'

export type PortableJson = null | boolean | number | string | PortableJsonArray | PortableJsonObject

export type PortableJsonArray = ReadonlyArray<PortableJson>

export interface PortableJsonObject {
  readonly [key: string]: PortableJson
}

const isEnumerableDataDescriptor = (descriptor: PropertyDescriptor) =>
  descriptor.enumerable === true &&
  descriptor.get === undefined &&
  descriptor.set === undefined &&
  Object.hasOwn(descriptor, 'value')

const snapshotPortableMetadata = (input: unknown): PortableJsonObject | undefined => {
  if (!Predicate.isObject(input)) return undefined

  const onPath = new Set<object>([input])
  const memo = new Map<object, PortableJsonArray | PortableJsonObject>()

  const recur = (value: unknown): PortableJson | undefined => {
    if (value === null || Predicate.isBoolean(value) || Predicate.isString(value)) return value

    if (Predicate.isNumber(value)) return Number.isFinite(value) ? value : undefined

    if (!Predicate.isObjectOrArray(value)) return undefined

    if (onPath.has(value)) return undefined

    const cached = memo.get(value)

    if (cached !== undefined) return cached

    onPath.add(value)

    const snapshot = Array.isArray(value) ? snapshotArray(value) : snapshotObject(value)

    onPath.delete(value)

    if (snapshot === undefined) memo.delete(value)

    return snapshot
  }

  const snapshotArray = (value: Array<unknown>): PortableJsonArray | undefined => {
    if (Object.getPrototypeOf(value) !== Array.prototype) return undefined

    if (Object.getOwnPropertySymbols(value).length !== 0) return undefined

    const names = Object.getOwnPropertyNames(value)

    if (names.length !== value.length + 1) return undefined

    const snapshot: Array<PortableJson> = []

    memo.set(value, snapshot)

    for (let index = 0; index < value.length; index++) {
      const key = String(index)

      const descriptor = Object.getOwnPropertyDescriptor(value, key)

      if (descriptor === undefined || !isEnumerableDataDescriptor(descriptor)) return undefined

      const child = recur(descriptor.value)

      if (child === undefined) return undefined

      snapshot[index] = child
    }

    return snapshot
  }

  const snapshotObject = (value: object): PortableJsonObject | undefined => {
    const proto = Object.getPrototypeOf(value)

    if (proto !== Object.prototype && proto !== null) return undefined

    if (Object.getOwnPropertySymbols(value).length !== 0) return undefined

    const keys = Object.keys(value)

    if (Object.getOwnPropertyNames(value).length !== keys.length) return undefined

    const snapshot: Record<string, PortableJson> = {}

    Object.setPrototypeOf(snapshot, null)
    memo.set(value, snapshot)

    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)

      if (descriptor === undefined || !isEnumerableDataDescriptor(descriptor)) return undefined

      const child = recur(descriptor.value)

      if (child === undefined) return undefined

      Object.defineProperty(snapshot, key, {
        value: child,
        enumerable: true,
        writable: true,
        configurable: true
      })
    }

    return snapshot
  }

  return snapshotObject(input)
}

/**
 * JSON-portable host annotations for `ConnectorIntegration` and `CredentialBinding`.
 *
 * Decode/`make` admit a **snapshot copy**, not the input identity:
 * - objects are copied onto a `null` prototype (own keys including `__proto__` /
 *   `constructor` are preserved via `defineProperty`)
 * - arrays are copied as dense `Array.prototype` arrays
 * - DAG aliases reuse the same snapshot node; cycles fail
 * - snapshots are not frozen
 *
 * Data contract (root must be a JSON object, never an array/`null`/primitive):
 * - own enumerable data properties only; hidden/symbol keys fail (no silent drop)
 * - accessor payload fields fail without invoking getters
 * - nested values are null | boolean | string | finite number | dense arrays |
 *   plain/`null`-prototype objects
 * - Date, Map, class/custom-prototype objects, functions, `undefined`, nonfinite
 *   numbers, sparse arrays, and cycles fail at every depth (no class→`{}`)
 * - unknown extension keys are allowed
 * - omitted metadata is absent; JSON `null` is a valid *value*, not a metadata object
 *
 * `getOwnPropertyDescriptor` / `Object.keys` traps on Proxies are not covered by
 * a general side-effect immunity claim. This is representation admission, not a
 * semantic meta-schema.
 *
 * Not integration `config`, not credential secrets, not error `underlying`.
 */
export const PortableMetadata = Schema.declareConstructor<PortableJsonObject>()(
  [],
  () => input => {
    const snapshot = snapshotPortableMetadata(input)

    return snapshot === undefined
      ? Effect.fail(
          new SchemaIssue.InvalidValue(Option.none(), {
            message: 'Expected a plain JSON metadata object'
          })
        )
      : Effect.succeed(snapshot)
  },
  {
    identifier: 'PortableMetadata',
    title: 'PortableMetadata',
    description:
      'Plain JSON object snapshot: finite values, dense arrays, own data keys; no Date/Map/class/accessors'
  }
)

export type PortableMetadata = typeof PortableMetadata.Type
