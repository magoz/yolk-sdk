import { Match } from 'effect'
import * as Schema from 'effect/Schema'
import { agentLoopErrorToAgentError, type AgentLoopError } from '@yolk-sdk/agent/loop'
import { AgentError } from '@yolk-sdk/agent/protocol'

export class SessionNotFoundError extends Schema.TaggedErrorClass<SessionNotFoundError>()(
  'SessionNotFoundError',
  {
    sessionId: Schema.String
  }
) {}

export class SessionLoadError extends Schema.TaggedErrorClass<SessionLoadError>()(
  'SessionLoadError',
  {
    sessionId: Schema.String,
    message: Schema.String
  }
) {}

export class SessionSaveError extends Schema.TaggedErrorClass<SessionSaveError>()(
  'SessionSaveError',
  {
    sessionId: Schema.String,
    message: Schema.String
  }
) {}

export class SessionConflictError extends Schema.TaggedErrorClass<SessionConflictError>()(
  'SessionConflictError',
  {
    sessionId: Schema.String,
    message: Schema.String
  }
) {}

export type RuntimeError =
  | SessionNotFoundError
  | SessionLoadError
  | SessionSaveError
  | SessionConflictError

export const runtimeErrorToAgentError = (error: RuntimeError | AgentLoopError): AgentError =>
  Match.value(error).pipe(
    Match.tag('SessionNotFoundError', notFound =>
      AgentError.make({
        code: 'session_not_found',
        message: `Session not found: ${notFound.sessionId}`,
        retryable: false
      })
    ),
    Match.tag('SessionLoadError', 'SessionSaveError', storeError =>
      AgentError.make({
        code: 'store_error',
        message: storeError.message,
        retryable: true
      })
    ),
    Match.tag('SessionConflictError', conflict =>
      AgentError.make({
        code: 'conflict',
        message: conflict.message,
        retryable: false
      })
    ),
    Match.tag(
      'LLMError',
      'ToolError',
      'ContextTransformError',
      'AbortError',
      'FauxExhaustedError',
      loopError => agentLoopErrorToAgentError(loopError)
    ),
    Match.exhaustive
  )
