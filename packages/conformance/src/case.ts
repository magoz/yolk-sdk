/**
 * Conformance cases: small, named, pure Effect programs that each prove one
 * claim about how an outside service really behaves on the wire.
 *
 * A case only states what it needs (its `R`); the same case runs unchanged
 * against replayed fixtures, an in-process emulator, a local emulator
 * process, or a real practice account. Only the layers a host provides
 * change. See `@yolk-sdk/conformance/runner` for the safety policy.
 *
 * @experimental
 */
import { Data, Effect, Equal, Result } from 'effect'
import * as Schema from 'effect/Schema'

/**
 * What a case does to the account it runs against:
 *
 * - `read`: only reads.
 * - `write-reversible`: writes but leaves the account as it found it (it
 *   creates its own records and cleans them up, or the write is rejected and
 *   changes nothing).
 * - `write-irreversible`: a write that cannot be undone (for example sending
 *   an email). Never automated against a live account.
 */
export const ConformanceSafety = Schema.Literals(['read', 'write-reversible', 'write-irreversible'])

export type ConformanceSafety = typeof ConformanceSafety.Type

/**
 * Dotted lower-case case id: two or more segments of `a-z`, `0-9`, and inner
 * hyphens, for example `vendor.stream.plain-text`.
 */
export const ConformanceCaseId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/)
)

const CalendarDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))

/** When and where a person last watched the claim hold against the real service. */
export const ConformanceObservation = Schema.Struct({
  /** Synthetic account label, for example `synthetic`; never a real account name. */
  account: Schema.NonEmptyString,
  /** Calendar date of the observation (`YYYY-MM-DD`, UTC). */
  date: CalendarDate
})

export type ConformanceObservation = typeof ConformanceObservation.Type

/**
 * One wire claim. `run` succeeds when the claim holds and fails (with a
 * `ConformanceMismatch`, its own error, or a port's error) when it does not.
 */
export type ConformanceCase<E = never, R = never> = {
  /** Dotted lower-case id (see `ConformanceCaseId`). */
  readonly id: string
  readonly title?: string
  readonly safety: ConformanceSafety
  /** What the service's documentation claims. */
  readonly docs: string
  /** What the wire actually does (the claim this case proves). */
  readonly wire: string
  /** Last live observation. Absent means the claim is unverified against the real service. */
  readonly observed?: ConformanceObservation
  /** Ids of the fixtures (`WireFixture`s or `PortFixture`s) that back replay of this case. */
  readonly fixtures: ReadonlyArray<string>
  readonly run: Effect.Effect<void, E, R>
}

const ConformanceCaseMetadata = Schema.Struct({
  id: ConformanceCaseId,
  title: Schema.optionalKey(Schema.NonEmptyString),
  safety: ConformanceSafety,
  docs: Schema.NonEmptyString,
  wire: Schema.NonEmptyString,
  observed: Schema.optionalKey(ConformanceObservation),
  fixtures: Schema.Array(Schema.NonEmptyString)
})

const validateMetadata = Schema.decodeUnknownResult(ConformanceCaseMetadata)

/**
 * Thrown by `defineConformanceCase` for an invalid definition. A programmer
 * error, surfaced when the defining module loads (like `makeTool`).
 */
export class ConformanceCaseInvalid extends Data.TaggedError('ConformanceCaseInvalid')<{
  readonly caseId: string
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid conformance case ${JSON.stringify(this.caseId)}: ${this.reason}`
  }
}

/**
 * Define a conformance case. The metadata (id format, safety, non-empty
 * `docs`/`wire`, observation date, fixture ids) is validated here and an
 * invalid definition throws `ConformanceCaseInvalid`: definitions are
 * module-level constants, so a bad one fails fast when the module loads
 * instead of surfacing mid-run.
 */
export const defineConformanceCase = <E = never, R = never>(
  spec: ConformanceCase<E, R>
): ConformanceCase<E, R> => {
  const { run: _run, ...metadata } = spec
  const result = validateMetadata(metadata)

  if (Result.isFailure(result)) {
    throw new ConformanceCaseInvalid({
      caseId: spec.id,
      reason: new Schema.SchemaError(result.failure.issue).message
    })
  }

  return spec
}

/**
 * A wire claim did not hold. Model-free: `expected` / `actual` are optional
 * JSON values chosen by the case author; keep them small and synthetic.
 */
export class ConformanceMismatch extends Data.TaggedError('ConformanceMismatch')<{
  readonly message: string
  readonly expected?: Schema.Json
  readonly actual?: Schema.Json
}> {}

export type ConformanceMismatchDetails = {
  readonly expected?: Schema.Json
  readonly actual?: Schema.Json
}

const mismatch = (message: string, details: ConformanceMismatchDetails = {}) =>
  new ConformanceMismatch({ message, ...details })

/** Succeed when `condition` holds; otherwise fail with a `ConformanceMismatch`. */
export const expectConformance = (
  condition: boolean,
  message: string,
  details?: ConformanceMismatchDetails
): Effect.Effect<void, ConformanceMismatch> =>
  condition ? Effect.void : Effect.fail(mismatch(message, details))

/**
 * Succeed when `actual` and `expected` are structurally equal JSON values
 * (effect `Equal.equals`: same primitives, same array order, same object keys
 * and values); otherwise fail with a `ConformanceMismatch` carrying both.
 */
export const expectEqual = (
  actual: Schema.Json,
  expected: Schema.Json,
  message: string
): Effect.Effect<void, ConformanceMismatch> =>
  expectConformance(Equal.equals(actual, expected), message, { expected, actual })
