import { describe, expect, it } from '@effect/vitest'
import {
  AbortError,
  agentLoopErrorToAgentError,
  FauxExhaustedError,
  LLMError,
  ToolError
} from '../../src/loop'
import { ProviderErrorInfo } from '@yolk-sdk/agent/protocol'

describe('agentLoopErrorToAgentError', () => {
  it('maps LLM errors directly to wire codes', () => {
    expect(
      agentLoopErrorToAgentError(
        new LLMError({
          cause: 'validation_error',
          message: 'bad input',
          retryable: false
        })
      )
    ).toMatchObject({ code: 'validation_error', message: 'bad input', retryable: false })
  })

  it('preserves LLM provider metadata on wire errors', () => {
    const provider = ProviderErrorInfo.make({
      provider: 'openai',
      kind: 'overloaded',
      status: 529,
      providerCode: 'overloaded_error',
      retryAfterMs: 250
    })

    expect(
      agentLoopErrorToAgentError(
        new LLMError({
          cause: 'overloaded',
          message: 'provider overloaded',
          retryable: true,
          provider
        })
      )
    ).toMatchObject({
      code: 'overloaded',
      message: 'provider overloaded',
      retryable: true,
      provider
    })
  })

  it('maps tool causes to canonical wire codes', () => {
    expect(
      agentLoopErrorToAgentError(
        new ToolError({ tool: 'search', message: 'bad args', cause: 'invalid_input' })
      )
    ).toMatchObject({ code: 'validation_error', message: 'bad args', retryable: false })

    expect(
      agentLoopErrorToAgentError(
        new ToolError({ tool: 'search', message: 'blocked', cause: 'denied' })
      )
    ).toMatchObject({ code: 'tool_denied', message: 'blocked', retryable: false })

    expect(
      agentLoopErrorToAgentError(
        new ToolError({ tool: 'search', message: 'late', cause: 'timeout' })
      )
    ).toMatchObject({ code: 'tool_timeout', message: 'late', retryable: true })

    expect(
      agentLoopErrorToAgentError(
        new ToolError({ tool: 'search', message: 'missing', cause: 'not_found' })
      )
    ).toMatchObject({ code: 'tool_error', message: 'missing', retryable: false })
  })

  it('maps abort and faux exhaustion errors', () => {
    expect(agentLoopErrorToAgentError(new AbortError({ reason: 'system' }))).toMatchObject({
      code: 'aborted',
      message: 'Agent run aborted: system',
      retryable: true
    })

    expect(
      agentLoopErrorToAgentError(new FauxExhaustedError({ message: 'no more faux responses' }))
    ).toMatchObject({
      code: 'provider_error',
      message: 'no more faux responses',
      retryable: false
    })
  })
})
