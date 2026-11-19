import { Predicate } from 'effect'

/**
 * The Workflow platform's step signals, recognized by name or flag like `@workflow/errors`: a
 * `FatalError` is never retried, a `RetryableError` waits until `retryAfter` before the next
 * attempt.
 */
export class FatalError extends Error {
  readonly fatal = true

  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.name = 'FatalError'
  }

  static is(value: unknown): value is Error {
    if (!(value instanceof Error)) return false

    return (
      value.name === 'FatalError' || (Predicate.hasProperty(value, 'fatal') && value.fatal === true)
    )
  }
}

export class RetryableError extends Error {
  readonly retryAfter: Date

  constructor(message: string, options: { readonly retryAfter?: number | string | Date } = {}) {
    super(message)
    this.name = 'RetryableError'
    this.retryAfter = new Date(Date.now() + toDurationMs(options.retryAfter ?? 1000))
  }

  static is(value: unknown): value is Error {
    return value instanceof Error && value.name === 'RetryableError'
  }
}

/** What a cancelled run's `returnValue` rejects with. */
export class WorkflowRunCancelledError extends Error {
  readonly runId: string

  constructor(runId: string) {
    super(`Workflow run ${runId} was cancelled`)
    this.name = 'WorkflowRunCancelledError'
    this.runId = runId
  }

  static is(value: unknown): value is WorkflowRunCancelledError {
    return value instanceof Error && value.name === 'WorkflowRunCancelledError'
  }
}

/** `resumeHook` for a token no run waits on. */
export class HookNotFoundError extends Error {
  readonly token: string

  constructor(token: string) {
    super(`No pending hook for token ${token}`)
    this.name = 'HookNotFoundError'
    this.token = token
  }

  static is(value: unknown): value is HookNotFoundError {
    return value instanceof Error && value.name === 'HookNotFoundError'
  }
}

/**
 * The platform's `HookConflictError` (its message, without the platform's docs link): awaiting a
 * hook fails with it when another live hook (of any run, its own included) held its token when the
 * run decided the hook. The refused hook never takes the token.
 */
export class HookConflictError extends Error {
  readonly token: string
  /** The run whose live hook holds the token. */
  readonly conflictingRunId: string | undefined

  constructor(token: string, conflictingRunId?: string) {
    super(
      `Hook token "${token}" is already in use by another workflow${
        conflictingRunId === undefined ? '' : ` (run "${conflictingRunId}")`
      }`
    )
    this.name = 'HookConflictError'
    this.token = token
    this.conflictingRunId = conflictingRunId
  }

  static is(value: unknown): value is HookConflictError {
    return value instanceof Error && value.name === 'HookConflictError'
  }
}

const day = 86_400_000

const units = new Map([
  ['ms', 1],
  ['msec', 1],
  ['millisecond', 1],
  ['s', 1000],
  ['sec', 1000],
  ['second', 1000],
  ['m', 60_000],
  ['min', 60_000],
  ['minute', 60_000],
  ['h', 3_600_000],
  ['hr', 3_600_000],
  ['hour', 3_600_000],
  ['d', day],
  ['day', day],
  ['w', 7 * day],
  ['week', 7 * day],
  ['y', 365.25 * day],
  ['yr', 365.25 * day],
  ['year', 365.25 * day]
])

/** `'1m'`, `'30s'`, `'2 hours'`, `'500'`: the duration strings Workflow's `sleep` takes. */
export const parseDuration = (text: string): number => {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(text)

  if (match === null) throw new Error(`Invalid duration: ${text}`)

  const amount = Number(match[1])
  const unit = (match[2] ?? '').toLowerCase()
  const factor = unit === '' ? 1 : (units.get(unit) ?? units.get(unit.replace(/s$/, '')))

  if (factor === undefined) throw new Error(`Invalid duration unit: ${text}`)

  return amount * factor
}

/** Milliseconds from now: a number is milliseconds, a string a duration, a `Date` a deadline. */
export const toDurationMs = (value: number | string | Date): number => {
  if (value instanceof Date) return value.getTime() - Date.now()

  if (Predicate.isNumber(value)) return value

  return parseDuration(value)
}
