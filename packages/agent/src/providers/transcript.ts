import { Effect, Match } from 'effect'
import { validateNoDanglingHostToolCalls, type AgentMessage } from '@yolk-sdk/agent/protocol'
import { LLMError } from '@yolk-sdk/agent/loop'

export const validateProviderTranscript = (
  messages: ReadonlyArray<AgentMessage>
): Effect.Effect<void, LLMError> =>
  Match.value(validateNoDanglingHostToolCalls(messages)).pipe(
    Match.tag('Valid', () => Effect.void),
    Match.tag('DanglingHostToolCalls', current =>
      Effect.fail(
        new LLMError({
          cause: 'validation_error',
          message: current.message,
          retryable: false
        })
      )
    ),
    Match.exhaustive
  )
