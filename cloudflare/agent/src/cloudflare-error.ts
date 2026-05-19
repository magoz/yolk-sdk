import { type AgentLoopError } from '@yolk-sdk/agent/loop'
import { runtimeErrorToAgentError, type RuntimeError } from '@yolk-sdk/agent/runtime'
import { AgentError } from '@yolk-sdk/agent/protocol'
import * as Schema from 'effect/Schema'

export const cloudflareRuntimeErrorToAgentError = (
  error: AgentLoopError | RuntimeError | Schema.SchemaError
) =>
  Schema.isSchemaError(error)
    ? AgentError.make({
        code: 'unknown',
        message: error.message,
        retryable: false
      })
    : runtimeErrorToAgentError(error)
