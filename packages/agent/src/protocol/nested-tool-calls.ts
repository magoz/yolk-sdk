import { Predicate, Result } from 'effect'
import * as Schema from 'effect/Schema'
import { addAgentUsage, AgentUsage } from './usage.ts'

const NonEmptyTrimmedString = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty()))

/** Default number of nested calls a record keeps; later calls are dropped (counted, not listed)
 * and mark the record incomplete. Callers size the record to their own call limit with
 * `makeNestedToolCallRecorder({ maxCalls })` (code mode uses `limits.maxNestedCalls`).
 */
export const nestedToolCallMaxCalls = 256

/** UTF-8 byte budget for one recorded call's compact JSON arguments. */
export const nestedToolCallMaxArgsBytes = 8 * 1024

/** UTF-8 byte budget for the compact JSON arguments of all recorded calls together. */
export const nestedToolCallMaxTotalArgsBytes = 32 * 1024

/** Recorded nested-call errors are cut to this many characters (code points). */
export const nestedToolCallMaxErrorChars = 500

const truncationMarker = '…'

export const NestedToolCallStatus = Schema.Literals(['ok', 'error', 'cancelled'])

export type NestedToolCallStatus = typeof NestedToolCallStatus.Type

/** One nested tool call made by a tool on behalf of the model (for example a code mode script).
 * Host/UI audit data only: never model-visible and never the nested result itself.
 * `args` is compact JSON, cut to the byte bounds with a trailing `…` (then no longer JSON).
 */
export class NestedToolCallRecord extends Schema.Class<NestedToolCallRecord>(
  'NestedToolCallRecord'
)({
  id: NonEmptyTrimmedString,
  name: NonEmptyTrimmedString,
  args: Schema.String,
  status: NestedToolCallStatus,
  durationMs: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  usage: Schema.optional(AgentUsage)
}) {}

/** Calls per status over every recorded call, including calls dropped from `calls`. */
export class NestedToolCallCounts extends Schema.Class<NestedToolCallCounts>(
  'NestedToolCallCounts'
)({
  ok: Schema.Number,
  error: Schema.Number,
  cancelled: Schema.Number
}) {}

/** Bounded nested-call record. `complete: false` means calls were dropped or arguments cut.
 * `counts` (absent on records written before it existed) counts every call by status, dropped
 * calls included, so totals stay correct when `calls` is cut.
 */
export class NestedToolCalls extends Schema.Class<NestedToolCalls>('NestedToolCalls')({
  calls: Schema.Array(NestedToolCallRecord),
  complete: Schema.Boolean,
  counts: Schema.optional(NestedToolCallCounts)
}) {}

export type NestedToolCallInput = {
  /** Caller-assigned id; the convention is `<parentToolCallId>/<seq>`. */
  readonly id: string
  readonly name: string
  /** Raw call arguments; recorded as compact JSON within the byte bounds. */
  readonly args: unknown
  readonly status: NestedToolCallStatus
  readonly durationMs?: number
  readonly error?: string
  readonly usage?: AgentUsage
}

type StatusCounts = {
  readonly ok: number
  readonly error: number
  readonly cancelled: number
}

const zeroCounts: StatusCounts = { ok: 0, error: 0, cancelled: 0 }

/** Immutable recorder state. Fold calls with `recordNestedToolCall`; usage and status counts of
 * dropped calls still count. `maxCalls` defaults to `nestedToolCallMaxCalls`.
 */
export type NestedToolCallRecorder = {
  readonly calls: ReadonlyArray<NestedToolCallRecord>
  readonly complete: boolean
  readonly argsBytes: number
  readonly usage?: AgentUsage
  readonly maxCalls?: number
  readonly counts?: StatusCounts
}

/** An empty recorder keeping at most `maxCalls` calls (default `nestedToolCallMaxCalls`); the
 * argument byte budgets are fixed.
 */
export const makeNestedToolCallRecorder = (
  options: { readonly maxCalls?: number } = {}
): NestedToolCallRecorder => ({
  calls: [],
  complete: true,
  argsBytes: 0,
  maxCalls: Math.max(0, Math.floor(options.maxCalls ?? nestedToolCallMaxCalls)),
  counts: zeroCounts
})

export const emptyNestedToolCallRecorder: NestedToolCallRecorder = makeNestedToolCallRecorder()

const codePointUtf8Bytes = (codePoint: number) =>
  codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4

const characterUtf8Bytes = (character: string) => codePointUtf8Bytes(character.codePointAt(0) ?? 0)

const utf8Bytes = (text: string) => {
  let bytes = 0

  for (const character of text) {
    bytes += characterUtf8Bytes(character)
  }

  return bytes
}

// Cuts on code point boundaries so surrogate pairs and multi-byte characters stay whole.
const truncateUtf8 = (text: string, maxBytes: number): string => {
  if (utf8Bytes(text) <= maxBytes) {
    return text
  }

  const budget = maxBytes - utf8Bytes(truncationMarker)

  if (budget < 0) {
    return ''
  }

  let bytes = 0
  let kept = ''

  for (const character of text) {
    const size = characterUtf8Bytes(character)

    if (bytes + size > budget) {
      break
    }

    kept += character
    bytes += size
  }

  return `${kept}${truncationMarker}`
}

const truncateCharacters = (text: string, maxCharacters: number) => {
  const characters = Array.from(text)

  return characters.length <= maxCharacters
    ? text
    : `${characters.slice(0, maxCharacters - 1).join('')}${truncationMarker}`
}

const compactArgs = (args: unknown): string =>
  Result.match(
    Result.try(() => JSON.stringify(args)),
    {
      onFailure: () => '[unserializable arguments]',
      onSuccess: (encoded: string | undefined) => (Predicate.isString(encoded) ? encoded : 'null')
    }
  )

type NestedToolCallRecordFields = {
  id: string
  name: string
  args: string
  status: NestedToolCallStatus
  durationMs?: number
  error?: string
  usage?: AgentUsage
}

/** Pure fold step enforcing the record bounds. Calls past the recorder's `maxCalls` are dropped
 * (still counted by status), arguments past the per-call or total byte budget are cut; either marks
 * the record incomplete. Errors are always cut to `nestedToolCallMaxErrorChars` without affecting
 * completeness.
 */
export const recordNestedToolCall = (
  recorder: NestedToolCallRecorder,
  input: NestedToolCallInput
): NestedToolCallRecorder => {
  const usage =
    input.usage === undefined
      ? recorder.usage
      : recorder.usage === undefined
        ? input.usage
        : addAgentUsage(recorder.usage, input.usage)

  type RecorderFields = {
    calls: ReadonlyArray<NestedToolCallRecord>
    complete: boolean
    argsBytes: number
    usage?: AgentUsage
    maxCalls?: number
    counts?: StatusCounts
  }

  const previousCounts = recorder.counts ?? zeroCounts

  const counts: StatusCounts = {
    ...previousCounts,
    [input.status]: previousCounts[input.status] + 1
  }

  const maxCalls = recorder.maxCalls ?? nestedToolCallMaxCalls

  const withUsage = (fields: RecorderFields): NestedToolCallRecorder => {
    if (usage !== undefined) {
      fields.usage = usage
    }

    fields.maxCalls = maxCalls
    fields.counts = counts

    return fields
  }

  if (recorder.calls.length >= maxCalls) {
    return withUsage({ calls: recorder.calls, complete: false, argsBytes: recorder.argsBytes })
  }

  const compact = compactArgs(input.args)

  const limit = Math.max(
    0,
    Math.min(nestedToolCallMaxArgsBytes, nestedToolCallMaxTotalArgsBytes - recorder.argsBytes)
  )

  const args = truncateUtf8(compact, limit)

  const fields: NestedToolCallRecordFields = {
    id: input.id,
    name: input.name,
    args,
    status: input.status
  }

  if (input.durationMs !== undefined) {
    fields.durationMs = input.durationMs
  }

  if (input.error !== undefined) {
    fields.error = truncateCharacters(input.error, nestedToolCallMaxErrorChars)
  }

  if (input.usage !== undefined) {
    fields.usage = input.usage
  }

  return withUsage({
    calls: [...recorder.calls, NestedToolCallRecord.make(fields)],
    complete: recorder.complete && args === compact,
    argsBytes: recorder.argsBytes + utf8Bytes(args)
  })
}

export type NestedToolCallResultFields = {
  readonly nestedCalls: NestedToolCalls
  readonly usage?: AgentUsage
}

/** `ToolResult` fields for a recorder: the bounded record with per-status counts plus summed
 * usage when reported.
 */
export const nestedToolCallResultFields = (
  recorder: NestedToolCallRecorder
): NestedToolCallResultFields => {
  const nestedCalls = NestedToolCalls.make({
    calls: recorder.calls,
    complete: recorder.complete,
    counts: NestedToolCallCounts.make(recorder.counts ?? zeroCounts)
  })

  return recorder.usage === undefined ? { nestedCalls } : { nestedCalls, usage: recorder.usage }
}
