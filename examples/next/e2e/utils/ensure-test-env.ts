import { Effect } from 'effect'

/**
 * Guard against running test operations outside NODE_ENV=test.
 * Uses Effect.die — this is a defect (programming error), not a recoverable failure.
 */
export const ensureTestEnv = (operation: string) =>
  process.env.NODE_ENV !== 'test'
    ? Effect.die(
        new Error(
          `Attempted to run test operation "${operation}" outside test environment.\n` +
            `Current NODE_ENV: ${process.env.NODE_ENV}`
        )
      )
    : Effect.void
