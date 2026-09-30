import { Effect, Exit } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  ConformanceCaseId,
  ConformanceCaseInvalid,
  ConformanceMismatch,
  ConformanceSafety,
  defineConformanceCase,
  expectConformance,
  expectEqual,
  type ConformanceCase
} from '../src/case.ts'

const validSpec: ConformanceCase = {
  id: 'example.items.read-one',
  title: 'Read one item',
  safety: 'read',
  docs: 'The docs say a missing item returns 404.',
  wire: 'A missing item returns 404 with an empty JSON body.',
  fixtures: ['example.items.read-one.synthetic'],
  run: Effect.void
}

describe('ConformanceCaseId', () => {
  it('accepts dotted lower-case ids', () => {
    const isId = Schema.is(ConformanceCaseId)

    for (const id of ['a.b', 'vendor.stream.plain-text', 'vendor-2.items.v1', 'x.y-z.q9']) {
      expect(isId(id)).toBe(true)
    }

    for (const id of [
      'single',
      'Upper.case',
      'a..b',
      'a.b.',
      '.a.b',
      'a.-b',
      'a.b-',
      'a b.c',
      ''
    ]) {
      expect(isId(id)).toBe(false)
    }
  })
})

describe('ConformanceSafety', () => {
  it.effect('decodes the three safety levels and rejects anything else', () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(ConformanceSafety)

      expect(yield* decode('read')).toBe('read')
      expect(yield* decode('write-reversible')).toBe('write-reversible')
      expect(yield* decode('write-irreversible')).toBe('write-irreversible')
      expect(Exit.isFailure(yield* Effect.exit(decode('write')))).toBe(true)
    })
  )
})

describe('defineConformanceCase', () => {
  it('returns the spec unchanged when valid', () => {
    expect(defineConformanceCase(validSpec)).toBe(validSpec)

    const observed = defineConformanceCase({
      ...validSpec,
      observed: { account: 'synthetic', date: '2026-09-01' }
    })

    expect(observed.observed).toEqual({ account: 'synthetic', date: '2026-09-01' })
  })

  it('throws ConformanceCaseInvalid for invalid definitions', () => {
    const invalid: ReadonlyArray<ConformanceCase> = [
      { ...validSpec, id: 'NotDotted' },
      { ...validSpec, id: 'example.Items' },
      { ...validSpec, docs: '' },
      { ...validSpec, wire: '' },
      { ...validSpec, fixtures: [''] },
      { ...validSpec, observed: { account: 'synthetic', date: '01/09/2026' } },
      { ...validSpec, observed: { account: '', date: '2026-09-01' } }
    ]

    for (const spec of invalid) {
      expect(() => defineConformanceCase(spec)).toThrow(ConformanceCaseInvalid)
    }

    expect(() => defineConformanceCase({ ...validSpec, id: 'NotDotted' })).toThrow(
      /Invalid conformance case "NotDotted"/
    )
  })
})

describe('assertion helpers', () => {
  it.effect('expectConformance succeeds or fails with a typed mismatch', () =>
    Effect.gen(function* () {
      yield* expectConformance(true, 'holds')

      const error = yield* expectConformance(false, 'text arrived after done', {
        expected: 'text before done',
        actual: ['done', 'text']
      }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(ConformanceMismatch)
      expect(error._tag).toBe('ConformanceMismatch')
      expect(error.message).toBe('text arrived after done')
      expect(error.expected).toBe('text before done')
      expect(error.actual).toEqual(['done', 'text'])

      const bare = yield* expectConformance(false, 'no details').pipe(Effect.flip)

      expect(bare).not.toHaveProperty('expected')
      expect(bare).not.toHaveProperty('actual')
    })
  )

  it.effect('expectEqual compares JSON values structurally', () =>
    Effect.gen(function* () {
      yield* expectEqual(
        { stream: true, tools: [{ name: 'lookup' }], limit: 3 },
        { limit: 3, tools: [{ name: 'lookup' }], stream: true },
        'same request'
      )
      yield* expectEqual(null, null, 'null')
      yield* expectEqual([1, 2], [1, 2], 'arrays')

      const reordered = yield* expectEqual([1, 2], [2, 1], 'order matters').pipe(Effect.flip)

      expect(reordered).toMatchObject({
        message: 'order matters',
        expected: [2, 1],
        actual: [1, 2]
      })

      const nested = yield* expectEqual(
        { call: { args: { city: 'Springfield' } } },
        { call: { args: { city: 'Shelbyville' } } },
        'arguments'
      ).pipe(Effect.flip)

      expect(nested._tag).toBe('ConformanceMismatch')

      const typed = yield* expectEqual(1, '1', 'no coercion').pipe(Effect.flip)

      expect(typed.message).toBe('no coercion')
    })
  )
})
