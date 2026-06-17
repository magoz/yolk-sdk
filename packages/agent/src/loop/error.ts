import * as Schema from 'effect/Schema'
import { AgentError, ProviderErrorInfo, type AgentErrorCode } from '@yolk-sdk/agent/protocol'

export class LLMError extends Schema.TaggedErrorClass<LLMError>()('LLMError', {
  cause: Schema.Literals([
    'validation_error',
    'provider_error',
    'rate_limit',
    'overloaded',
    'context_overflow',
    'invalid_response'
  ]),
  message: Schema.String,
  retryable: Schema.Boolean,
  provider: Schema.optional(ProviderErrorInfo)
}) {}

export class FauxExhaustedError extends Schema.TaggedErrorClass<FauxExhaustedError>()(
  'FauxExhaustedError',
  {
    message: Schema.String
  }
) {}

export class ToolError extends Schema.TaggedErrorClass<ToolError>()('ToolError', {
  tool: Schema.String,
  message: Schema.String,
  cause: Schema.Literals([
    'validation',
    'invalid_input',
    'execution',
    'timeout',
    'permission',
    'denied',
    'not_found',
    'unavailable'
  ])
}) {}

export class ContextTransformError extends Schema.TaggedErrorClass<ContextTransformError>()(
  'ContextTransformError',
  {
    cause: Schema.Literals(['context_overflow', 'invalid_response']),
    message: Schema.String,
    retryable: Schema.Boolean
  }
) {}

export class AbortError extends Schema.TaggedErrorClass<AbortError>()('AbortError', {
  reason: Schema.Literals(['user', 'system', 'max_turns'])
}) {}

export type LLMProviderError = LLMError | FauxExhaustedError | AbortError

export type AgentLoopError = LLMProviderError | ToolError | ContextTransformError

const toolErrorCode = (error: ToolError): AgentErrorCode => {
  switch (error.cause) {
    case 'validation':
    case 'invalid_input':
      return 'validation_error'
    case 'timeout':
      return 'tool_timeout'
    case 'permission':
    case 'denied':
      return 'tool_denied'
    case 'execution':
    case 'not_found':
    case 'unavailable':
      return 'tool_error'
  }
}

export const agentLoopErrorToAgentError = (error: AgentLoopError): AgentError => {
  switch (error._tag) {
    case 'LLMError':
      return AgentError.make({
        code: error.cause,
        message: error.message,
        retryable: error.retryable,
        ...(error.provider === undefined ? {} : { provider: error.provider })
      })
    case 'ToolError':
      return AgentError.make({
        code: toolErrorCode(error),
        message: error.message,
        retryable: error.cause === 'timeout'
      })
    case 'ContextTransformError':
      return AgentError.make({
        code: error.cause,
        message: error.message,
        retryable: error.retryable
      })
    case 'AbortError':
      return AgentError.make({
        code: 'aborted',
        message: `Agent run aborted: ${error.reason}`,
        retryable: error.reason === 'system'
      })
    case 'FauxExhaustedError':
      return AgentError.make({
        code: 'provider_error',
        message: error.message,
        retryable: false
      })
  }
}
