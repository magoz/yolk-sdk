/**
 * `isMissingFinalOutputIssue` (#370): Codex missing-output recovery is decided from the decode
 * issue's structure (a `MissingKey` under `output`), never from the formatted message.
 */
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { isMissingFinalOutputIssue } from '../../src/providers/openai-responses-provider-internal.ts'

const Item = Schema.Struct({ type: Schema.Literal('function_call'), call_id: Schema.String })

const Response = Schema.Struct({
  output: Schema.Array(Item),
  usage: Schema.optional(Schema.Struct({ input_tokens: Schema.Number }))
})

const failureOf = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.flip,
    Effect.catch(() => Effect.die('expected a decode failure'))
  )

describe('isMissingFinalOutputIssue', () => {
  it.effect('recognizes a missing output and a key missing inside an output item', () =>
    Effect.gen(function* () {
      const withoutOutput = yield* failureOf(Response, {})
      const withoutCallId = yield* failureOf(Response, { output: [{ type: 'function_call' }] })

      expect(isMissingFinalOutputIssue(withoutOutput.issue)).toBe(true)
      expect(isMissingFinalOutputIssue(withoutCallId.issue)).toBe(true)
    })
  )

  it.effect('rejects a missing key outside output and a wrong type inside it', () =>
    Effect.gen(function* () {
      const usageMissingKey = yield* failureOf(Response, { output: [], usage: {} })

      const wrongType = yield* failureOf(Response, {
        output: [{ type: 'function_call', call_id: 1 }]
      })

      expect(isMissingFinalOutputIssue(usageMissingKey.issue)).toBe(false)
      expect(isMissingFinalOutputIssue(wrongType.issue)).toBe(false)
    })
  )

  it.effect('reads the issue, not a message that only reads like a missing output', () =>
    Effect.gen(function* () {
      // A check failure at `output` whose own text is "Missing key": the formatted message holds
      // both substrings the old text predicate matched, but nothing is missing.
      const LookAlike = Schema.Struct({
        output: Schema.String.check(Schema.makeFilter(() => 'Missing key'))
      })

      const failure = yield* failureOf(LookAlike, { output: 'present' })

      expect(failure.message).toContain('Missing key')
      expect(failure.message).toContain('["output"]')
      expect(isMissingFinalOutputIssue(failure.issue)).toBe(false)
    })
  )
})
