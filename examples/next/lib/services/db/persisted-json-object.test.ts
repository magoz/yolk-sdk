import { Effect, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  decodePersistedJsonObject,
  encodePersistedJsonObject,
  persistedJsonObjectErrorMessage
} from './persisted-json-object'

const expectRejected = (value: unknown) =>
  Effect.gen(function* () {
    const decoded = yield* decodePersistedJsonObject(value).pipe(Effect.result)
    const encoded = yield* encodePersistedJsonObject(value).pipe(Effect.result)

    expect(Result.isFailure(decoded)).toBe(true)
    expect(Result.isFailure(encoded)).toBe(true)

    if (Result.isFailure(decoded)) {
      expect(Schema.isSchemaError(decoded.failure)).toBe(true)
      expect(decoded.failure.message).toContain('Expected a plain JSON object')
      expect(persistedJsonObjectErrorMessage(decoded.failure)).toBe(
        `Invalid knowledge metadata: ${decoded.failure.message}`
      )
    }
  })

describe('PersistedJsonObject', () => {
  it.effect('admits empty, open-key, and nested JSON objects', () =>
    Effect.gen(function* () {
      const nested = {
        a: 1,
        sheetNames: ['A', 'B'],
        nested: { k: true, n: null, z: 0, off: false },
        storageObjectId: 'obj_1',
        title: 'Notes'
      }

      const decoded = yield* decodePersistedJsonObject(nested)
      const encoded = yield* encodePersistedJsonObject(nested)

      expect(decoded).not.toBe(nested)
      expect(encoded).not.toBe(nested)
      expect(decoded).toMatchObject(nested)
      expect(encoded).toMatchObject(nested)
      expect(Object.getPrototypeOf(decoded)).toBe(null)
      expect(yield* decodePersistedJsonObject({})).toEqual({})
    })
  )

  it.effect('preserves extra unknown keys including own __proto__ and constructor', () =>
    Effect.gen(function* () {
      const parsed: unknown = JSON.parse(
        '{"format":"xlsx","title":"sheet","extra":{"ok":true},"__proto__":{"keep":true},"constructor":null}'
      )

      const decoded = yield* decodePersistedJsonObject(parsed)

      expect(decoded).not.toBe(parsed)
      expect(decoded.format).toBe('xlsx')
      expect(decoded.title).toBe('sheet')
      expect(decoded.extra).toEqual({ ok: true })
      expect(Object.hasOwn(decoded, '__proto__')).toBe(true)
      expect(decoded['__proto__']).toEqual({ keep: true })
      expect(decoded['constructor']).toBe(null)
    })
  )

  it.effect('snapshots owned data and preserves DAG aliases', () =>
    Effect.gen(function* () {
      const leaf = { ok: true }
      const input = { a: leaf, b: leaf, count: 1 }
      const encoded = yield* encodePersistedJsonObject(input)

      input.count = 99
      leaf.ok = false

      expect(encoded.count).toBe(1)
      expect(encoded.a).toBe(encoded.b)
      expect(encoded.a).not.toBe(leaf)
      expect(encoded.a).toEqual({ ok: true })
    })
  )

  it.effect('omits undefined object keys on encode without treating them as nested JSON', () =>
    Effect.gen(function* () {
      const encoded = yield* encodePersistedJsonObject({
        format: 'pdf',
        title: undefined,
        pageCount: 3
      })

      expect(encoded).toEqual({ format: 'pdf', pageCount: 3 })
      expect(Object.hasOwn(encoded, 'title')).toBe(false)
    })
  )

  it.effect('rejects undefined object values on read rather than repairing stored data', () =>
    Effect.gen(function* () {
      const decoded = yield* decodePersistedJsonObject({ title: undefined }).pipe(Effect.result)

      expect(Result.isFailure(decoded)).toBe(true)
    })
  )

  it.effect('rejects reflection failures with a safe typed schema error', () =>
    expectRejected(
      new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error('private-reflection-rejection')
          }
        }
      )
    )
  )

  it.effect('rejects sparse arrays and symbol or hidden properties', () =>
    Effect.gen(function* () {
      yield* expectRejected({ items: new Array(2) })
      yield* expectRejected({ [Symbol('private-key')]: true })
      yield* expectRejected(Object.defineProperty({}, 'hidden', { value: 'private-value' }))
    })
  )

  it.effect('rejects array, scalar, JSON null, and undefined roots', () =>
    Effect.gen(function* () {
      yield* expectRejected([])
      yield* expectRejected([1])
      yield* expectRejected('x')
      yield* expectRejected(1)
      yield* expectRejected(true)
      yield* expectRejected(null)
      yield* expectRejected(undefined)
    })
  )

  it.effect('rejects nested non-JSON, nonfinite numbers, class instances, and Dates', () =>
    Effect.gen(function* () {
      class Box {
        ok = true
      }

      yield* expectRejected({ when: new Date('2020-01-01T00:00:00.000Z') })
      yield* expectRejected({ fn: () => 'secret' })
      yield* expectRejected({ box: new Box() })
      yield* expectRejected({ n: Number.POSITIVE_INFINITY })
      yield* expectRejected({ n: Number.NaN })
      yield* expectRejected({ nested: [undefined] })
    })
  )

  it.effect('rejects cycles and accessors without invoking getters or echoing secrets', () =>
    Effect.gen(function* () {
      const cyclic = {}

      Object.defineProperty(cyclic, 'self', { value: cyclic, enumerable: true })

      yield* expectRejected(cyclic)

      let reads = 0

      const accessor = {
        get secret() {
          reads += 1

          return 's3cret-token'
        }
      }

      const decoded = yield* decodePersistedJsonObject(accessor).pipe(Effect.result)
      const encoded = yield* encodePersistedJsonObject(accessor).pipe(Effect.result)

      expect(Result.isFailure(encoded)).toBe(true)
      expect(Result.isFailure(decoded)).toBe(true)
      expect(reads).toBe(0)

      if (Result.isFailure(decoded)) {
        expect(decoded.failure.message).toContain('Expected a plain JSON object')
        expect(decoded.failure.message).not.toContain('s3cret-token')
      }
    })
  )
})
