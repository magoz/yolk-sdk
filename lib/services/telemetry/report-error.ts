import { Effect } from 'effect'
import * as Sentry from '@sentry/nextjs'

export const reportError = <E extends { _tag: string; message: string }>(
  error: E,
  context?: Record<string, unknown>
) =>
  Effect.gen(function* () {
    const errorTag = error._tag
    const errorMessage = error.message

    // Log to console
    yield* Effect.logError(errorMessage, {
      error_type: errorTag,
      ...context
    })

    // Capture in Sentry
    yield* Effect.sync(() =>
      Sentry.captureException(error, {
        tags: {
          error_type: errorTag
        },
        extra: {
          ...context,
          errorDetails: error
        }
      })
    )
  })
