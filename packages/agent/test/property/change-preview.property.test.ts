import { Arbitrary, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { boundToolChangePreview, ToolChangePreview } from '../../src/tools/index.ts'
import { propertyOptions } from './property-options'

const Input = Schema.Struct({
  preview: ToolChangePreview,
  maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 128, maximum: 4096 }))
})

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

const isPreview = Schema.is(ToolChangePreview)

describe('boundToolChangePreview properties', () => {
  it.prop(
    'fits the bound or fails too_large, deterministically, marking every changed value',
    [Arbitrary.schema(Input)],
    ([{ preview, maxBytes }]) => {
      const first = boundToolChangePreview(preview, maxBytes)
      const second = boundToolChangePreview(preview, maxBytes)

      expect(first).toEqual(second)

      if (Result.isFailure(first)) {
        expect(first.failure.cause).toBe('too_large')
        expect(bytes(preview)).toBeGreaterThan(maxBytes)

        return
      }

      const bounded = first.success

      expect(bytes(bounded)).toBeLessThanOrEqual(maxBytes)
      expect(isPreview(bounded)).toBe(true)
      expect(bounded.target).toEqual(preview.target)
      expect(bounded.changes.map(change => [change._tag, change.field, change.label])).toEqual(
        preview.changes.map(change => [change._tag, change.field, change.label])
      )

      bounded.changes.forEach((change, index) => {
        const original = preview.changes[index]

        if (JSON.stringify(change) !== JSON.stringify(original))
          expect(change.truncated).toBeDefined()

        // A marker the bound added records the full original size.
        if (Predicate.isTagged(change, 'Text') && Predicate.isTagged(original, 'Text')) {
          if (change.truncated?.after !== undefined && original.truncated?.after === undefined)
            expect(change.truncated.after.originalSize).toBe(Array.from(original.after).length)
        }

        if (Predicate.isTagged(change, 'Set') && Predicate.isTagged(original, 'Set')) {
          if (change.truncated?.added !== undefined && original.truncated?.added === undefined)
            expect(change.truncated.added.originalSize).toBe(original.added.length)
        }
      })

      // A bounded preview is a fixed point.
      expect(boundToolChangePreview(bounded, maxBytes)).toEqual(Result.succeed(bounded))
    },
    propertyOptions
  )
})
