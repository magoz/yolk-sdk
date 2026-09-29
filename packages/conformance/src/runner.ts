/**
 * Conformance runner: decides which cases may run against a target (safety
 * policy), runs each allowed case in isolation with freshly built layers, and
 * produces a plain-data report.
 *
 * The runner never performs network I/O itself; whatever the per-case layer
 * provides (a replay `HttpClient`, an emulator, or a host's live client) is
 * what the case talks to.
 *
 * @experimental
 */
import { Cause, Clock, Effect, Exit, Option, Predicate, type Layer } from 'effect'
import { ConformanceMismatch, type ConformanceCase, type ConformanceSafety } from './case.ts'
import { fixtureAgeDays, type WireFixture } from './fixture.ts'
import { redactCredentialText } from './wire-internal.ts'

/**
 * Where cases run. `replay`, `in-process`, and `emulated` never touch a real
 * account, so every case runs. `live` talks to a real practice account and is
 * gated by the safety policy (see `conformanceSkipReason`).
 */
export type ConformanceTarget =
  | { readonly kind: 'replay' | 'in-process' | 'emulated' }
  | {
      readonly kind: 'live'
      /** Synthetic, non-identifying account label (for example `practice`). */
      readonly account: string
      /** `reversible` lets `write-reversible` cases run. Default `none`. */
      readonly allowWrites?: 'none' | 'reversible'
      /** Exact ids of `write-irreversible` cases a person explicitly started. */
      readonly allowIrreversible?: ReadonlyArray<string>
    }

export type ConformanceTargetKind = ConformanceTarget['kind']

export type ConformanceSkipReason = 'writes-not-allowed' | 'manual-only'

/**
 * The safety policy. `undefined` means the case may run.
 *
 * - `replay` / `in-process` / `emulated`: every case runs.
 * - `live`: `read` runs; `write-reversible` runs only with
 *   `allowWrites: 'reversible'` (else `writes-not-allowed`);
 *   `write-irreversible` runs only when its exact id is in
 *   `allowIrreversible` (else `manual-only`), independent of `allowWrites`.
 */
export const conformanceSkipReason = (
  target: ConformanceTarget,
  testCase: { readonly id: string; readonly safety: ConformanceSafety }
): ConformanceSkipReason | undefined => {
  if (target.kind !== 'live') {
    return undefined
  }

  switch (testCase.safety) {
    case 'read':
      return undefined
    case 'write-reversible':
      return target.allowWrites === 'reversible' ? undefined : 'writes-not-allowed'
    case 'write-irreversible':
      return (target.allowIrreversible ?? []).includes(testCase.id) ? undefined : 'manual-only'
  }
}

/** Non-fatal findings attached to a case result. */
export type ConformanceWarning =
  /** The case has no `observed`: its claim was never watched against the real service. */
  | { readonly kind: 'unverified-case' }
  /** `observed.date` is older than the max age (`ageDays` absent when unreadable). */
  | { readonly kind: 'stale-observation'; readonly ageDays?: number }
  /** A referenced fixture is a synthetic placeholder (`evidence: 'unverified'`). */
  | { readonly kind: 'unverified-fixture'; readonly fixtureId: string }
  /** A referenced fixture is older than the max age (`ageDays` absent when unreadable). */
  | { readonly kind: 'stale-fixture'; readonly fixtureId: string; readonly ageDays?: number }
  /** A referenced fixture id is not among the supplied fixtures. */
  | { readonly kind: 'missing-fixture'; readonly fixtureId: string }

export type ConformanceWarningKind = ConformanceWarning['kind']

/**
 * Sanitized failure. `message` is a `ConformanceMismatch`'s case-authored
 * message (credential patterns redacted) or, for every other failure, layer
 * failure, and defect, the error's own message passed through
 * `sanitizeConformanceMessage` (credential patterns and cookies redacted, JSON
 * spans elided, whitespace collapsed, length capped). `tag` is the error's
 * `_tag` only when it is identifier-like. Request bodies, headers, and
 * `ConformanceMismatch` `expected`/`actual` details are never copied.
 */
export type ConformanceFailure = {
  /** `failure`: typed error (including layer build errors); `defect`: unexpected die. */
  readonly kind: 'failure' | 'defect'
  readonly tag?: string
  readonly message: string
}

export type ConformanceCaseStatus = 'passed' | 'failed' | 'skipped'

export type ConformanceCaseResult = {
  readonly id: string
  readonly safety: ConformanceSafety
  readonly status: ConformanceCaseStatus
  readonly skipReason?: ConformanceSkipReason
  readonly failure?: ConformanceFailure
  readonly durationMs: number
  readonly warnings: ReadonlyArray<ConformanceWarning>
}

export type ConformanceReport = {
  readonly target: { readonly kind: ConformanceTargetKind; readonly account?: string }
  /** ISO timestamp of the run start. */
  readonly startedAt: string
  readonly results: ReadonlyArray<ConformanceCaseResult>
  readonly summary: {
    readonly passed: number
    readonly failed: number
    readonly skipped: number
  }
}

/** What a case (or a union of cases) needs from its layer. */
export type ConformanceCaseRequirements<C> = C extends {
  readonly run: Effect.Effect<void, unknown, infer R>
}
  ? R
  : never

type RunSettings = {
  readonly target: ConformanceTarget
  /** Fixtures to check referenced ids against (evidence, staleness, missing ids). */
  readonly fixtures?: ReadonlyArray<WireFixture>
  /** Reference time for staleness and `startedAt`. Defaults to the Effect `Clock`. */
  readonly now?: Date
  /** Fixtures and observations older than this many whole days are stale. Default 30. */
  readonly maxFixtureAgeDays?: number
  /** Cases run in parallel up to this limit. Default 1: live accounts are shared. */
  readonly concurrency?: number
}

/**
 * Options for `runConformance` over cases of type `C` (a union when the cases
 * differ).
 *
 * `layer` is called once per case that runs and must provide everything that
 * case needs (`ConformanceCaseRequirements<C>`; providing more is fine). It is
 * called and built inside the case's failure boundary, with a fresh memo map
 * in its own scope, so state the layer allocates when it is built (replay
 * consumption, ledgers, emulator state) never leaks between cases, even when
 * the factory returns the same `Layer` value. Services captured in a shared
 * value (for example one `Layer.succeed(service, instance)`) or supplied by
 * the caller's environment are not rebuilt and stay shared. Build failures
 * (`LE`) and a throwing factory are reported as failed cases. `LR` is
 * whatever the layers still need from the caller (for example a live
 * `HttpClient`) and becomes the requirement of the whole run.
 */
export type ConformanceRunOptions<C, LE = never, LR = never> = RunSettings & {
  readonly layer: (testCase: C) => Layer.Layer<ConformanceCaseRequirements<C>, LE, LR>
}

const staleAge = (
  date: string,
  now: Date,
  maxAgeDays: number
): Option.Option<number | undefined> => {
  const age = fixtureAgeDays({ recordedAt: date }, now)

  if (Number.isNaN(age)) {
    return Option.some(undefined)
  }

  return age > maxAgeDays ? Option.some(age) : Option.none()
}

const withAge = <W extends { readonly kind: string }>(
  warning: W,
  ageDays: number | undefined
): W | (W & { readonly ageDays: number }) =>
  ageDays === undefined ? warning : { ...warning, ageDays }

/**
 * Warnings for one case. Case-level warnings always apply; fixture-level ones
 * only on non-live targets and only when `fixtures` were supplied.
 */
export const conformanceCaseWarnings = (
  testCase: Pick<ConformanceCase<unknown, unknown>, 'observed' | 'fixtures'>,
  context: {
    readonly target: ConformanceTarget
    readonly now: Date
    readonly fixtures?: ReadonlyArray<WireFixture> | undefined
    readonly maxFixtureAgeDays?: number | undefined
  }
): ReadonlyArray<ConformanceWarning> => {
  const maxAgeDays = context.maxFixtureAgeDays ?? 30
  const warnings: Array<ConformanceWarning> = []

  if (testCase.observed === undefined) {
    warnings.push({ kind: 'unverified-case' })
  } else {
    const stale = staleAge(testCase.observed.date, context.now, maxAgeDays)

    if (Option.isSome(stale)) {
      warnings.push(withAge({ kind: 'stale-observation' }, stale.value))
    }
  }

  const fixtures = context.fixtures

  if (context.target.kind === 'live' || fixtures === undefined) {
    return warnings
  }

  for (const fixtureId of testCase.fixtures) {
    const fixture = fixtures.find(candidate => candidate.id === fixtureId)

    if (fixture === undefined) {
      warnings.push({ kind: 'missing-fixture', fixtureId })
      continue
    }

    if (fixture.evidence === 'unverified') {
      warnings.push({ kind: 'unverified-fixture', fixtureId })
    }

    const stale = staleAge(fixture.recordedAt, context.now, maxAgeDays)

    if (Option.isSome(stale)) {
      warnings.push(withAge({ kind: 'stale-fixture', fixtureId }, stale.value))
    }
  }

  return warnings
}

const maxFailureMessageLength = 300

// Only identifier-like tags are reported; anything else (spaces, punctuation, payload text) is
// dropped.
const reportableTagPattern = /^[A-Za-z][A-Za-z0-9_]*$/

const collapseAndCap = (message: string): string => {
  const compact = message.replace(/\s+/g, ' ').trim()

  return compact.length > maxFailureMessageLength
    ? `${compact.slice(0, maxFailureMessageLength - 3)}...`
    : compact
}

/**
 * End index of the balanced `{...}` / `[...]` segment opening at `start` (strings respected);
 * `undefined` when it never closes or closes with the wrong bracket.
 */
const balancedSegmentEnd = (text: string, start: number): number | undefined => {
  const expected: Array<string> = []
  let inString = false

  for (let index = start; index < text.length; index++) {
    const char = text[index]

    if (inString) {
      if (char === '\\') {
        index++
      } else if (char === '"') {
        inString = false
      }

      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      expected.push('}')
    } else if (char === '[') {
      expected.push(']')
    } else if (char === '}' || char === ']') {
      if (expected.pop() !== char) {
        return undefined
      }

      if (expected.length === 0) {
        return index
      }
    }
  }

  return undefined
}

// Replace every balanced `{...}` / `[...]` segment with `[json]`. An unbalanced opening bracket
// (for example a truncated body) elides the rest of the message.
const elideJsonSpans = (text: string): string => {
  let output = ''
  let index = 0

  while (index < text.length) {
    const char = text[index]

    if (char !== '{' && char !== '[') {
      output += char
      index++
      continue
    }

    const end = balancedSegmentEnd(text, index)
    output += '[json]'

    if (end === undefined) {
      return output
    }

    index = end + 1
  }

  return output
}

/**
 * Best-effort sanitizer for failure messages copied into a `ConformanceReport`. Redacts the
 * credential patterns shared with the fixture secret scan (bearer tokens, API-key prefixes, JWTs,
 * private keys, credential field pairs, credential query/form parameters, and credential header
 * lines such as `Cookie:` or `X-Api-Key:` to the end of the line), replaces JSON-looking spans
 * (balanced `{...}` / `[...]`) with `[json]`, collapses whitespace, and caps the length at 300
 * characters. Hosts should still keep secrets out of error messages.
 */
export const sanitizeConformanceMessage = (message: string): string =>
  collapseAndCap(elideJsonSpans(redactCredentialText(message)))

// A `ConformanceMismatch` message is written by the case author: keep it readable (no JSON
// elision), but still redact credential patterns.
const sanitizeMismatchMessage = (message: string): string =>
  collapseAndCap(redactCredentialText(message))

const stringProperty = (value: unknown, key: string): string | undefined => {
  if (!Predicate.hasProperty(value, key)) {
    return undefined
  }

  const property = value[key]

  return Predicate.isString(property) && property.length > 0 ? property : undefined
}

const describeValue = (kind: ConformanceFailure['kind'], value: unknown): ConformanceFailure => {
  const rawTag = stringProperty(value, '_tag')

  // Identifier-like and not credential-shaped (e.g. a `vck_...` value is never echoed).
  const tag =
    rawTag !== undefined &&
    reportableTagPattern.test(rawTag) &&
    redactCredentialText(rawTag) === rawTag
      ? rawTag
      : undefined

  const rawMessage =
    stringProperty(value, 'message') ??
    (Predicate.isString(value) && value.length > 0 ? value : undefined)

  const message =
    rawMessage === undefined
      ? (tag ?? (kind === 'defect' ? 'unexpected defect' : 'case failed'))
      : value instanceof ConformanceMismatch
        ? sanitizeMismatchMessage(rawMessage)
        : sanitizeConformanceMessage(rawMessage)

  const failure = { kind, message }

  return tag === undefined ? failure : { ...failure, tag }
}

const describeCause = <E>(cause: Cause.Cause<E>): ConformanceFailure => {
  const error = Cause.findErrorOption(cause)

  if (Option.isSome(error)) {
    return describeValue('failure', error.value)
  }

  return describeValue('defect', Cause.squash(cause))
}

type Counts = { passed: number; failed: number; skipped: number }

const summarize = (results: ReadonlyArray<ConformanceCaseResult>): Counts => {
  const counts: Counts = { passed: 0, failed: 0, skipped: 0 }

  for (const result of results) {
    counts[result.status] += 1
  }

  return counts
}

// Pins object literals to the result type so `status` stays a literal.
const identityResult = (result: ConformanceCaseResult): ConformanceCaseResult => result

const reportTarget = (target: ConformanceTarget): ConformanceReport['target'] =>
  target.kind === 'live' ? { kind: target.kind, account: target.account } : { kind: target.kind }

/**
 * Run cases against a target and report. Skipped cases never build their
 * layer. Each running case gets a fresh layer and runs under `Effect.exit`:
 * failures, layer build failures, defects, and a throwing `layer` factory
 * become `failed` results and the run continues. Interruption is not
 * captured: interrupting the run (or a case interrupting itself) interrupts
 * the whole run.
 *
 * `C` is inferred as the union of the given case types, so cases with
 * different errors and requirements can share one run without annotations.
 */
export function runConformance<C extends ConformanceCase<unknown, unknown>, LE = never, LR = never>(
  cases: ReadonlyArray<C>,
  options: ConformanceRunOptions<C, LE, LR>
): Effect.Effect<ConformanceReport, never, LR>
// Implementation signature: one case type whose `run` needs exactly `R`, which
// is what the public signature's `ConformanceCaseRequirements<C>` denotes.
export function runConformance<E, R, LE, LR>(
  cases: ReadonlyArray<ConformanceCase<E, R>>,
  options: RunSettings & {
    readonly layer: (testCase: ConformanceCase<E, R>) => Layer.Layer<R, LE, LR>
  }
): Effect.Effect<ConformanceReport, never, LR> {
  return Effect.gen(function* () {
    const now = options.now ?? new Date(yield* Clock.currentTimeMillis)

    const warningContext = {
      target: options.target,
      now,
      fixtures: options.fixtures,
      maxFixtureAgeDays: options.maxFixtureAgeDays
    }

    const runCase = (testCase: ConformanceCase<E, R>) =>
      Effect.gen(function* () {
        const base = {
          id: testCase.id,
          safety: testCase.safety,
          warnings: conformanceCaseWarnings(testCase, warningContext)
        }

        const skipReason = conformanceSkipReason(options.target, testCase)

        if (skipReason !== undefined) {
          return identityResult({ ...base, status: 'skipped', skipReason, durationMs: 0 })
        }

        const started = yield* Clock.currentTimeMillis

        // The factory runs inside the exit boundary: a throwing factory fails this case only.
        const exit = yield* Effect.suspend(() =>
          testCase.run.pipe(Effect.provide(options.layer(testCase), { local: true }))
        ).pipe(Effect.exit)

        const durationMs = (yield* Clock.currentTimeMillis) - started

        if (Exit.isSuccess(exit)) {
          return identityResult({ ...base, status: 'passed', durationMs })
        }

        if (Cause.hasInterruptsOnly(exit.cause)) {
          return yield* Effect.interrupt
        }

        return identityResult({
          ...base,
          status: 'failed',
          failure: describeCause(exit.cause),
          durationMs
        })
      })

    const results = yield* Effect.forEach(cases, runCase, {
      concurrency: options.concurrency ?? 1
    })

    return {
      target: reportTarget(options.target),
      startedAt: now.toISOString(),
      results,
      summary: summarize(results)
    }
  })
}

/** True when any case failed. Skipped cases never fail a report. */
export const conformanceReportFailed = (report: ConformanceReport): boolean =>
  report.summary.failed > 0

const statusLabel: Record<ConformanceCaseStatus, string> = {
  passed: 'PASS',
  failed: 'FAIL',
  skipped: 'SKIP'
}

const formatAge = (ageDays: number | undefined): string =>
  ageDays === undefined ? '(unreadable date)' : `(${ageDays}d)`

const formatWarning = (warning: ConformanceWarning): string => {
  switch (warning.kind) {
    case 'unverified-case':
      return warning.kind
    case 'stale-observation':
      return `${warning.kind}${formatAge(warning.ageDays)}`
    case 'unverified-fixture':
    case 'missing-fixture':
      return `${warning.kind}:${warning.fixtureId}`
    case 'stale-fixture':
      return `${warning.kind}:${warning.fixtureId}${formatAge(warning.ageDays)}`
  }
}

const formatDetail = (result: ConformanceCaseResult): string | undefined => {
  if (result.skipReason !== undefined) {
    return result.skipReason
  }

  if (result.failure === undefined) {
    return undefined
  }

  const prefix = result.failure.kind === 'defect' ? 'defect ' : ''
  const tag = result.failure.tag === undefined ? '' : `${result.failure.tag}: `

  return `${prefix}${tag}${result.failure.message}`
}

/**
 * Compact plain text (no colors): one line per case with status, id, safety,
 * skip reason or failure message, and warnings, then a summary line.
 */
export const formatConformanceReport = (report: ConformanceReport): string => {
  const lines = report.results.map(result => {
    const detail = formatDetail(result)

    const warnings =
      result.warnings.length === 0
        ? undefined
        : `warnings: ${result.warnings.map(formatWarning).join(', ')}`

    return [statusLabel[result.status], result.id, `[${result.safety}]`, detail, warnings]
      .filter(Predicate.isNotUndefined)
      .join('  ')
  })

  const target =
    report.target.account === undefined
      ? report.target.kind
      : `${report.target.kind} (account ${report.target.account})`

  const { passed, failed, skipped } = report.summary

  return [
    ...lines,
    `${passed} passed, ${failed} failed, ${skipped} skipped; target ${target}; started ${report.startedAt}`
  ].join('\n')
}
