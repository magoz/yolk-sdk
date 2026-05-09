import { Schedule } from 'effect'
import { SqlError } from 'effect/unstable/sql/SqlError'

// Exponential backoff
// Handles network issues, cold starts, and transient cloud infrastructure problems
// Retries: immediate, +500ms, +1s, +2s (max 3 retries, ~3.5s total)
export const retryPolicy = Schedule.exponential('500 millis', 2.0).pipe(
  Schedule.both(Schedule.recurs(3)),
  Schedule.jittered
)

const hasIsTransient = (error: unknown): error is { isTransient: true } =>
  typeof error === 'object' &&
  error !== null &&
  'isTransient' in error &&
  error.isTransient === true

export const isTransientError = (error: unknown): boolean =>
  hasIsTransient(error) || error instanceof SqlError

// Usage example:
// .pipe(
//   Effect.retry({
//     while: isTransientError,
//     schedule: retryPolicy
//   })
// )
