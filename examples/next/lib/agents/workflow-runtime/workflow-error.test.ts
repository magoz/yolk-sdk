import { describe, expect, it } from '@effect/vitest'
import { ToolError } from '@yolk-sdk/agent/loop'
import { SessionNotFoundError } from '@yolk-sdk/agent/runtime'
import { AgentDocumentLimitError, AgentResponseEncodingError } from '@/lib/agents/route-handler'
import { workflowErrorEvent } from './workflow-error'

describe('workflowErrorEvent', () => {
  it('maps route validation errors', () => {
    expect(
      workflowErrorEvent(new AgentDocumentLimitError({ message: 'Attach up to 4 PDFs.' }))
    ).toMatchObject({
      _tag: 'AgentError',
      code: 'validation_error',
      message: 'Attach up to 4 PDFs.',
      retryable: false
    })
  })

  it('maps loop errors with typed codes', () => {
    expect(
      workflowErrorEvent(
        new ToolError({ tool: 'search', message: 'Tool timed out', cause: 'timeout' })
      )
    ).toMatchObject({
      _tag: 'AgentError',
      code: 'tool_timeout',
      message: 'Tool timed out',
      retryable: true
    })
  })

  it('maps runtime errors with typed codes', () => {
    expect(workflowErrorEvent(new SessionNotFoundError({ sessionId: 'session_1' }))).toMatchObject({
      _tag: 'AgentError',
      code: 'session_not_found',
      message: 'Session not found: session_1',
      retryable: false
    })
  })

  it('maps response encoding errors', () => {
    expect(
      workflowErrorEvent(new AgentResponseEncodingError({ message: 'bad event' }))
    ).toMatchObject({
      _tag: 'AgentError',
      code: 'invalid_response',
      message: 'bad event',
      retryable: false
    })
  })
})
