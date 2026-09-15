import { Effect } from 'effect'
import { admitTelemetryLogContext, type TelemetryLogContext } from './telemetry-context'

export type { TelemetryLogContext }

export const reportError = <E extends { _tag: string; message: string }>(
  error: E,
  context?: TelemetryLogContext
) =>
  Effect.gen(function* () {
    const admitted = yield* admitTelemetryLogContext(context)

    // Context projection never sanitizes messages; callers own message privacy.
    yield* Effect.logError(error.message).pipe(
      Effect.annotateLogs({
        ...admitted,
        error_type: error._tag
      })
    )
  })
