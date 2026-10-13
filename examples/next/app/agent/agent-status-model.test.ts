import { describe, expect, it } from '@effect/vitest'
import {
  AgentBlocked,
  AgentBusy,
  AgentCompacting,
  AgentDone,
  AgentFailed,
  AgentGenerating,
  AgentRetry,
  AgentRetrying,
  AgentRunningTools,
  AgentWorking,
  QuestionPrompt,
  QuestionRequest,
  ToolCall,
  idleAgentStatus
} from '@yolk-sdk/agent/protocol'
import { textStatusLabel, textStatusVariant } from './agent-status-model'

const question = QuestionRequest.make({
  requestId: 'question:call_q',
  toolCallId: 'call_q',
  call: ToolCall.make({ id: 'call_q', name: 'question', params: {} }),
  questions: [QuestionPrompt.make({ id: 'q', prompt: 'Which one?' })]
})

const tool = (toolCallId: string, name: string) => ({ toolCallId, name })

describe('agent status labels', () => {
  it('labels every working activity', () => {
    const working = (activity: AgentWorking['activity']) =>
      textStatusLabel(AgentWorking.make({ activity }))

    expect(working(AgentBusy.make({}))).toBe('working')
    expect(working(AgentGenerating.make({}))).toBe('generating')
    expect(working(AgentRunningTools.make({ calls: [tool('a', 'search')] }))).toBe('running search')
    expect(
      working(AgentRunningTools.make({ calls: [tool('a', 'search'), tool('b', 'fetch')] }))
    ).toBe('running tools')
    expect(working(AgentCompacting.make({ strategy: 'summary' }))).toBe('compacting')
    expect(
      working(
        AgentRetrying.make({
          retry: AgentRetry.make({ attempt: 1, reason: 'overloaded', delayMs: 1, message: 'x' })
        })
      )
    ).toBe('retrying')
  })

  it('labels every blocked kind', () => {
    expect(textStatusLabel(AgentBlocked.make({ kind: 'permission', requests: [question] }))).toBe(
      'needs approval'
    )
    expect(textStatusLabel(AgentBlocked.make({ kind: 'question', requests: [question] }))).toBe(
      'needs answer'
    )
    expect(textStatusLabel(AgentBlocked.make({ kind: 'auth', requests: [question] }))).toBe(
      'needs sign-in'
    )
  })

  it('labels and styles settled statuses', () => {
    expect(textStatusLabel(idleAgentStatus)).toBe('idle')
    expect(textStatusLabel(AgentDone.make({}))).toBe('done')
    expect(textStatusLabel(AgentFailed.make({ message: 'x' }))).toBe('failed')
    expect(textStatusVariant(AgentDone.make({}))).toBe('secondary')
    expect(textStatusVariant(AgentFailed.make({ message: 'x' }))).toBe('destructive')
    expect(textStatusVariant(idleAgentStatus)).toBe('outline')
  })
})
