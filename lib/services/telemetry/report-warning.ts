import { Effect } from 'effect'

export const reportWarning = <W extends { _tag: string; message: string }>(
  warning: W,
  context?: Record<string, unknown>
) =>
  Effect.gen(function* () {
    const warningTag = warning._tag
    const warningMessage = warning.message

    yield* Effect.logWarning(warningMessage, {
      warning_type: warningTag,
      ...context
    })
  })
