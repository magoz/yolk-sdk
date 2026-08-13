import { Data } from 'effect'
import * as Schema from 'effect/Schema'
import {
  AbortError,
  ContextTransformError,
  FauxExhaustedError,
  LLMError,
  ToolError,
  type AgentLoopError
} from '@yolk-sdk/agent/loop'
import { AgentError } from '@yolk-sdk/agent/protocol'
import {
  runtimeErrorToAgentError,
  SessionConflictError,
  SessionLoadError,
  SessionNotFoundError,
  SessionSaveError,
  type RuntimeError
} from '@yolk-sdk/agent/runtime'
import {
  AgentDocumentLimitError,
  AgentImageLimitError,
  AgentResponseEncodingError
} from '@/lib/agents/route-handler'

export class AgentWorkflowStepError extends Data.TaggedError('AgentWorkflowStepError')<{
  message: string
  cause?: unknown
}> {}

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Workflow agent failed'

const unknownPublicMessage = 'Workflow agent failed unexpectedly'

const knownRuntimeError = (error: unknown): RuntimeError | AgentLoopError | undefined => {
  if (Schema.is(SessionNotFoundError)(error)) {
    return error
  }
  if (Schema.is(SessionLoadError)(error)) {
    return error
  }
  if (Schema.is(SessionSaveError)(error)) {
    return error
  }
  if (Schema.is(SessionConflictError)(error)) {
    return error
  }
  if (Schema.is(LLMError)(error)) {
    return error
  }
  if (Schema.is(ToolError)(error)) {
    return error
  }
  if (Schema.is(ContextTransformError)(error)) {
    return error
  }
  if (Schema.is(AbortError)(error)) {
    return error
  }
  if (Schema.is(FauxExhaustedError)(error)) {
    return error
  }

  return undefined
}

export const workflowErrorEvent = (error: unknown) => {
  if (Schema.is(AgentError)(error)) {
    return error
  }

  const runtimeError = knownRuntimeError(error)
  if (runtimeError !== undefined) {
    return runtimeErrorToAgentError(runtimeError)
  }

  if (Schema.is(AgentImageLimitError)(error) || Schema.is(AgentDocumentLimitError)(error)) {
    return AgentError.make({
      code: 'validation_error',
      message: error.message,
      retryable: false
    })
  }

  if (Schema.is(AgentResponseEncodingError)(error)) {
    return AgentError.make({
      code: 'invalid_response',
      message: error.message,
      retryable: false
    })
  }

  return AgentError.make({
    code: 'unknown',
    message: unknownPublicMessage,
    retryable: false
  })
}

export const workflowStepError = (error: unknown) =>
  new AgentWorkflowStepError({
    message: unknownToMessage(error),
    cause: error
  })
