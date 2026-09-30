/**
 * Shared test helpers for the request a Gateway wire fixture recorded. Replay matches requests by
 * method and URL only, so fixture-backed tests derive their settings from these recorded fields
 * and compare them with the replay ledger, so each test sends the request its fixture recorded.
 */
import { Predicate, Schema } from 'effect'
import { expect } from '@effect/vitest'
import { AgentReasoningEffort } from '@yolk-sdk/agent/protocol'
import type { WireFixture } from '@yolk-sdk/conformance/fixture'

/** The request fields a replayed request must send exactly as the fixture recorded them. */
export const recordedRequestFields = [
  'model',
  'reasoning_effort',
  'thinking',
  'max_tokens',
  'stream',
  'tools'
] as const

export const recordedRequestBody = (fixture: WireFixture): unknown =>
  fixture.exchanges[0].request.body

const recordedField = (fixture: WireFixture, field: string): unknown => {
  const body = recordedRequestBody(fixture)

  return Predicate.hasProperty(body, field)
    ? body[field]
    : expect.fail(`${fixture.id} recorded no request \`${field}\``)
}

export const recordedString = (fixture: WireFixture, field: string): string => {
  const value = recordedField(fixture, field)

  return Predicate.isString(value) ? value : expect.fail(`${fixture.id} \`${field}\` is no string`)
}

export const recordedNumber = (fixture: WireFixture, field: string): number => {
  const value = recordedField(fixture, field)

  return Predicate.isNumber(value) ? value : expect.fail(`${fixture.id} \`${field}\` is no number`)
}

export const recordedReasoningEffort = (fixture: WireFixture): AgentReasoningEffort => {
  const value = recordedField(fixture, 'reasoning_effort')

  return Schema.is(AgentReasoningEffort)(value)
    ? value
    : expect.fail(`${fixture.id} \`reasoning_effort\` is no reasoning effort`)
}

/** Only the fields present, so a field sent but never recorded (or the reverse) is a mismatch. */
export const pickRecordedRequestFields = (body: unknown) =>
  recordedRequestFields.flatMap(field =>
    Predicate.hasProperty(body, field) ? [{ field, value: body[field] }] : []
  )
