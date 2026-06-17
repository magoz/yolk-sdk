import { Effect } from 'effect'
import {
  validateNoDanglingHostToolCalls,
  type AgentMessage
} from '@yolk-sdk/agent/protocol'
import { LLMError } from '@yolk-sdk/agent/loop'

export const validateProviderTranscript = (
  messages: ReadonlyArray<AgentMessage>
): Effect.Effect<void, LLMError> => {
  const validation = validateNoDanglingHostToolCalls(messages)

  if (validation._tag === 'Valid') {
    return Effect.void
  }

  return Effect.fail(
    new LLMError({
      cause: 'validation_error',
      message: validation.message,
      retryable: false
    })
  )
}
