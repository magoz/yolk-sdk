import { describe, expect, it } from '@effect/vitest'
import { LLMError } from '@yolk-sdk/agent/loop'
import {
  runtimeErrorToAgentError,
  SessionConflictError,
  SessionLoadError,
  SessionNotFoundError,
  SessionSaveError
} from '../../src/runtime'

describe('runtimeErrorToAgentError', () => {
  it('maps session store errors to canonical wire codes', () => {
    expect(
      runtimeErrorToAgentError(
        new SessionLoadError({ sessionId: 'session_1', message: 'load failed' })
      )
    ).toMatchObject({ code: 'store_error', message: 'load failed', retryable: true })

    expect(
      runtimeErrorToAgentError(
        new SessionSaveError({ sessionId: 'session_1', message: 'save failed' })
      )
    ).toMatchObject({ code: 'store_error', message: 'save failed', retryable: true })
  })

  it('maps session identity and conflict errors', () => {
    expect(
      runtimeErrorToAgentError(new SessionNotFoundError({ sessionId: 'session_1' }))
    ).toMatchObject({
      code: 'session_not_found',
      message: 'Session not found: session_1',
      retryable: false
    })

    expect(
      runtimeErrorToAgentError(
        new SessionConflictError({ sessionId: 'session_1', message: 'revision mismatch' })
      )
    ).toMatchObject({ code: 'conflict', message: 'revision mismatch', retryable: false })
  })

  it('delegates loop errors', () => {
    expect(
      runtimeErrorToAgentError(
        new LLMError({ cause: 'rate_limit', message: 'slow down', retryable: true })
      )
    ).toMatchObject({ code: 'rate_limit', message: 'slow down', retryable: true })
  })
})
