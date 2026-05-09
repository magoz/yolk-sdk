import { Effect } from 'effect'
import * as Sentry from '@sentry/nextjs'

export const reportWarning = <W extends { _tag: string; message: string }>(
  warning: W,
  context?: Record<string, unknown>
) =>
  Effect.gen(function* () {
    const warningTag = warning._tag
    const warningMessage = warning.message

    // Log to console
    yield* Effect.logWarning(warningMessage, {
      warning_type: warningTag,
      ...context
    })

    // Send to Sentry at warning level
    yield* Effect.sync(() =>
      Sentry.captureMessage(warningMessage, {
        level: 'warning',
        tags: { warning_type: warningTag },
        extra: { ...context, warningDetails: warning }
      })
    )
  })
