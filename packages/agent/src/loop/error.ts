import { Match } from 'effect'
import * as Schema from 'effect/Schema'
import { AgentError, ProviderErrorInfo, type AgentErrorCode } from '@yolk-sdk/agent/protocol'

export const LLMResponseIssue = Schema.Literal('missing_done')

export type LLMResponseIssue = typeof LLMResponseIssue.Type

export class LLMError extends Schema.TaggedError<LLMError>()('LLMError', {
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
  provider: Schema.optional(ProviderErrorInfo),
  responseIssue: Schema.optional(LLMResponseIssue)
}) {}

export class FauxExhaustedError extends Schema.TaggedError<FauxExhaustedError>()(
  'FauxExhaustedError',
  {
    message: Schema.String
  }
) {}

export class ToolError extends Schema.TaggedError<ToolError>()('ToolError', {
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

export class ContextTransformError extends Schema.TaggedError<ContextTransformError>()(
  'ContextTransformError',
  {
    cause: Schema.Literals(['context_overflow', 'invalid_response']),
    message: Schema.String,
    retryable: Schema.Boolean
  }
) {}

export class AbortError extends Schema.TaggedError<AbortError>()('AbortError', {
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

export const agentLoopErrorToAgentError = (error: AgentLoopError): AgentError =>
  Match.value(error).pipe(
    Match.tag('LLMError', current => {
      type AgentErrorFields = {
        code: AgentErrorCode
        message: string
        retryable: boolean
        provider?: AgentError['provider']
      }

      return AgentError.make(
        (() => {
          const fields: AgentErrorFields = {
            code: current.cause,
            message: current.message,
            retryable: current.retryable
          }

          if (current.provider !== undefined) {
            fields.provider = current.provider
          }

          return fields
        })()
      )
    }),
    Match.tag('ToolError', current =>
      AgentError.make({
        code: toolErrorCode(current),
        message: current.message,
        retryable: current.cause === 'timeout'
      })
    ),
    Match.tag('ContextTransformError', current =>
      AgentError.make({
        code: current.cause,
        message: current.message,
        retryable: current.retryable
      })
    ),
    Match.tag('AbortError', current =>
      AgentError.make({
        code: 'aborted',
        message: `Agent run aborted: ${current.reason}`,
        retryable: current.reason === 'system'
      })
    ),
    Match.tag('FauxExhaustedError', current =>
      AgentError.make({
        code: 'provider_error',
        message: current.message,
        retryable: false
      })
    ),
    Match.exhaustive
  )
