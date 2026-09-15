import { Effect, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import * as SchemaIssue from 'effect/SchemaIssue'

export type PersistedJson =
  | null
  | boolean
  | number
  | string
  | PersistedJsonArray
  | PersistedJsonObject

export type PersistedJsonArray = ReadonlyArray<PersistedJson>

export interface PersistedJsonObject {
  readonly [key: string]: PersistedJson
}

const isEnumerableDataDescriptor = (descriptor: PropertyDescriptor) =>
  descriptor.enumerable === true &&
  descriptor.get === undefined &&
  descriptor.set === undefined &&
  Object.hasOwn(descriptor, 'value')

const failedSnapshot = undefined

const isPlainObjectPrototype = (value: object) => {
  const proto: unknown = Object.getPrototypeOf(value)

  return proto === Object.prototype || proto === null
}

const snapshotPersistedJsonObject = (
  input: unknown,
  omitUndefined: boolean
): PersistedJsonObject | undefined => {
  if (input === null || input === undefined) {
    return failedSnapshot
  }

  if (!Predicate.isObjectOrArray(input) || Array.isArray(input) || !Predicate.isObject(input)) {
    return failedSnapshot
  }

  const onPath = new Set<object>([input])
  const memo = new Map<object, PersistedJsonArray | PersistedJsonObject>()

  const recur = (value: unknown): PersistedJson | undefined => {
    if (value === undefined) {
      return failedSnapshot
    }

    if (value === null || Predicate.isBoolean(value) || Predicate.isString(value)) {
      return value
    }

    if (Predicate.isNumber(value)) {
      return Number.isFinite(value) ? value : failedSnapshot
    }

    if (!Predicate.isObjectOrArray(value)) {
      return failedSnapshot
    }

    if (onPath.has(value)) {
      return failedSnapshot
    }

    const cached = memo.get(value)

    if (cached !== undefined) {
      return cached
    }

    onPath.add(value)

    const snapshot = Array.isArray(value) ? snapshotArray(value) : snapshotObject(value)

    onPath.delete(value)

    if (snapshot === undefined) {
      memo.delete(value)
    }

    return snapshot
  }

  const snapshotArray = (value: Array<unknown>): PersistedJsonArray | undefined => {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      return failedSnapshot
    }

    if (Object.getOwnPropertySymbols(value).length !== 0) {
      return failedSnapshot
    }

    const names = Object.getOwnPropertyNames(value)

    if (names.length !== value.length + 1) {
      return failedSnapshot
    }

    const snapshot: Array<PersistedJson> = []

    memo.set(value, snapshot)

    for (let index = 0; index < value.length; index++) {
      const key = String(index)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)

      if (descriptor === undefined || !isEnumerableDataDescriptor(descriptor)) {
        return failedSnapshot
      }

      const nested: unknown = descriptor.value

      if (nested === undefined) {
        return failedSnapshot
      }

      const child = recur(nested)

      if (child === undefined) {
        return failedSnapshot
      }

      snapshot[index] = child
    }

    return snapshot
  }

  const snapshotObject = (value: object): PersistedJsonObject | undefined => {
    if (!isPlainObjectPrototype(value)) {
      return failedSnapshot
    }

    if (Object.getOwnPropertySymbols(value).length !== 0) {
      return failedSnapshot
    }

    const keys = Object.keys(value)

    if (Object.getOwnPropertyNames(value).length !== keys.length) {
      return failedSnapshot
    }

    const snapshot: Record<string, PersistedJson> = {}

    Object.setPrototypeOf(snapshot, null)
    memo.set(value, snapshot)

    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)

      if (descriptor === undefined || !isEnumerableDataDescriptor(descriptor)) {
        return failedSnapshot
      }

      const nested: unknown = descriptor.value

      if (nested === undefined) {
        if (omitUndefined) continue

        return failedSnapshot
      }

      const child = recur(nested)

      if (child === undefined) {
        return failedSnapshot
      }

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

/** JSON object snapshot for jsonb metadata: open string keys, finite nested JSON.
 * Root arrays, null, primitives, accessors, cycles, and nonportable values fail.
 * Undefined object keys are omitted on write; they are not valid nested JSON.
 */
const invalidJsonObject = () =>
  new SchemaIssue.InvalidValue({ message: 'Expected a plain JSON object' })

const persistedJsonObjectSchema = (omitUndefined: boolean) =>
  Schema.declareConstructor<PersistedJsonObject>()(
    [],
    () => input =>
      Effect.try({
        try: () => snapshotPersistedJsonObject(input, omitUndefined),
        catch: invalidJsonObject
      }).pipe(
        Effect.flatMap(snapshot =>
          snapshot === undefined ? Effect.fail(invalidJsonObject()) : Effect.succeed(snapshot)
        )
      ),
    {
      identifier: 'PersistedJsonObject',
      title: 'PersistedJsonObject',
      description:
        'Plain JSON object snapshot for jsonb metadata. Finite nested JSON; no Date/Map/class/accessors/cycles.'
    }
  )

export const PersistedJsonObject = persistedJsonObjectSchema(false)

export const decodePersistedJsonObject = Schema.decodeUnknownEffect(PersistedJsonObject)

// File extractors may emit absent optional properties explicitly. Normalize these
// only at the write boundary; a read must not silently repair invalid persisted data.
export const encodePersistedJsonObject = Schema.encodeUnknownEffect(persistedJsonObjectSchema(true))

export const persistedJsonObjectErrorMessage = (error: Schema.SchemaError) =>
  `Invalid knowledge metadata: ${error.message}`
