import { Effect } from 'effect'

export const reportError = <E extends { _tag: string; message: string }>(
  error: E,
  context?: Record<string, unknown>
) =>
  Effect.gen(function* () {
    const errorTag = error._tag
    const errorMessage = error.message

    yield* Effect.logError(errorMessage, {
      error_type: errorTag,
      ...context
    })
  })
