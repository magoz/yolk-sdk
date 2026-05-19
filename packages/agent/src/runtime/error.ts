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

export const runtimeErrorToAgentError = (error: RuntimeError | AgentLoopError): AgentError => {
  switch (error._tag) {
    case 'SessionNotFoundError':
      return AgentError.make({
        code: 'session_not_found',
        message: `Session not found: ${error.sessionId}`,
        retryable: false
      })
    case 'SessionLoadError':
    case 'SessionSaveError':
      return AgentError.make({
        code: 'store_error',
        message: error.message,
        retryable: true
      })
    case 'SessionConflictError':
      return AgentError.make({
        code: 'conflict',
        message: error.message,
        retryable: false
      })
    case 'LLMError':
    case 'ToolError':
    case 'ContextTransformError':
    case 'AbortError':
    case 'FauxExhaustedError':
      return agentLoopErrorToAgentError(error)
  }
}
