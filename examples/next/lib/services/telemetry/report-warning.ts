import { Effect } from 'effect'
import { admitTelemetryLogContext, type TelemetryLogContext } from './telemetry-context'

export type { TelemetryLogContext }

export const reportWarning = <W extends { _tag: string; message: string }>(
  warning: W,
  context?: TelemetryLogContext
) =>
  Effect.gen(function* () {
    const admitted = yield* admitTelemetryLogContext(context)

    // Context projection never sanitizes messages; callers own message privacy.
    yield* Effect.logWarning(warning.message).pipe(
      Effect.annotateLogs({
        ...admitted,
        warning_type: warning._tag
      })
    )
  })
