import { Predicate } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { ToolError } from '@yolk-sdk/agent/loop'
import { AgentError } from '@yolk-sdk/agent/protocol'
import { SessionNotFoundError } from '@yolk-sdk/agent/runtime'
import { AgentDocumentLimitError, AgentResponseEncodingError } from '@/lib/agents/route-handler'
import { workflowErrorEvent } from './workflow-error'

describe('workflowErrorEvent', () => {
  it('preserves already-normalized agent errors', () => {
    const error = AgentError.make({
      code: 'context_overflow',
      message: 'Input exceeded context.',
      retryable: false
    })

    expect(workflowErrorEvent(error)).toEqual(error)
  })

  it('maps route validation errors', () => {
    const event = workflowErrorEvent(
      new AgentDocumentLimitError({ message: 'Attach up to 4 PDFs.' })
    )

    expect(Predicate.isTagged(event, 'AgentError')).toBe(true)
    expect(event).toMatchObject({
      code: 'validation_error',
      message: 'Attach up to 4 PDFs.',
      retryable: false
    })
  })

  it('maps loop errors with typed codes', () => {
    const event = workflowErrorEvent(
      new ToolError({ tool: 'search', message: 'Tool timed out', cause: 'timeout' })
    )

    expect(Predicate.isTagged(event, 'AgentError')).toBe(true)
    expect(event).toMatchObject({
      code: 'tool_timeout',
      message: 'Tool timed out',
      retryable: true
    })
  })

  it('maps runtime errors with typed codes', () => {
    const event = workflowErrorEvent(new SessionNotFoundError({ sessionId: 'session_1' }))
    expect(Predicate.isTagged(event, 'AgentError')).toBe(true)
    expect(event).toMatchObject({
      code: 'session_not_found',
      message: 'Session not found: session_1',
      retryable: false
    })
  })

  it('redacts unexpected defect details from public errors', () => {
    const event = workflowErrorEvent(new Error('SENSITIVE_DEFECT_DETAIL'))
    expect(Predicate.isTagged(event, 'AgentError')).toBe(true)
    expect(event).toMatchObject({
      code: 'unknown',
      message: 'Workflow agent failed unexpectedly',
      retryable: false
    })
  })

  it('maps response encoding errors', () => {
    const event = workflowErrorEvent(new AgentResponseEncodingError({ message: 'bad event' }))
    expect(Predicate.isTagged(event, 'AgentError')).toBe(true)
    expect(event).toMatchObject({
      code: 'invalid_response',
      message: 'bad event',
      retryable: false
    })
  })
})
