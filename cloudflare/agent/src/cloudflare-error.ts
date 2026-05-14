import { type AgentLoopError } from '@yolk/agent/loop'
import { runtimeErrorToAgentError, type RuntimeError } from '@yolk/agent/runtime'
import { AgentError } from '@yolk/agent/protocol'
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
