import { Arbitrary, Match, Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  boundToolChangePreview,
  ToolChangePreview,
  type ToolChangeCut,
  type ToolFieldChange
} from '../../src/tools/index.ts'
import { propertyOptions } from './property-options'

const Input = Schema.Struct({
  preview: ToolChangePreview,
  maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 128, maximum: 4096 }))
})

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

const isPreview = Schema.is(ToolChangePreview)

type Side = 'before' | 'after' | 'added' | 'removed'

// Each cuttable side of a change with its marker (`Set.unchanged` is dropped, not cut).
const sidesOf = (
  change: ToolFieldChange
): ReadonlyArray<readonly [Side, ToolChangeCut | undefined]> =>
  Predicate.isTagged(change, 'Set')
    ? [
        ['added', change.truncated?.added],
        ['removed', change.truncated?.removed]
      ]
    : [
        ['before', change.truncated?.before],
        ['after', change.truncated?.after]
      ]

const sizeOf = (value: unknown) =>
  Predicate.isString(value)
    ? Array.from(value).length
    : Array.isArray(value)
      ? value.length
      : bytes(value)

const originalSizeOf = (change: ToolFieldChange, side: Side) =>
  Match.value(change).pipe(
    Match.tagsExhaustive({
      Value: value => sizeOf(side === 'before' ? value.before : value.after),
      Text: text => sizeOf(side === 'before' ? text.before : text.after),
      Set: set => sizeOf(side === 'added' ? set.added : set.removed),
      List: list => sizeOf(side === 'before' ? list.before : list.after),
      Structured: structured => bytes(side === 'before' ? structured.before : structured.after)
    })
  )

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

        // A marker the bound added records the full original size of that value.
        if (original !== undefined)
          sidesOf(change).forEach(([side, cut]) => {
            const before = sidesOf(original).find(([name]) => name === side)

            if (cut !== undefined && before !== undefined && before[1] === undefined)
              expect(cut.originalSize).toBe(originalSizeOf(original, side))
          })
      })

      // A bounded preview is a fixed point.
      expect(boundToolChangePreview(bounded, maxBytes)).toEqual(Result.succeed(bounded))
    },
    propertyOptions
  )
})
