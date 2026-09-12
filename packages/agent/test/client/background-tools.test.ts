import { describe, expect, it } from '@effect/vitest'
import {
  AgentEnd,
  zeroAgentUsage,
  AgentStart,
  AssistantAgentMessage,
  HostToolCallPart,
  ToolResultMessage,
  UserMessage,
  BackgroundToolAccepted,
  ToolApprovalPolicy,
  ToolApprovalRequest,
  ToolApprovalRequested,
  ToolCall,
  ToolExecutionAccepted,
  ToolExecutionStarted,
  ToolInputStart,
  ToolInputDelta,
  ToolInputEnd,
  makeBackgroundToolAcceptedResult
} from '@yolk-sdk/agent/protocol'
import {
  applyAgentEvent,
  initialAgentClientState,
  isActiveToolRun,
  completedToolRuns,
  submitAgentUserMessage,
  markAgentAborted,
  markAgentError
} from '@yolk-sdk/agent/client'

const call = ToolCall.make({
  id: 'work',
  name: 'work',
  params: { execution: 'background', arguments: {} }
})

const result = makeBackgroundToolAcceptedResult({
  toolCallId: call.id,
  acceptance: BackgroundToolAccepted.make({ version: 1, executionId: 'owner:work' })
})

const started = ToolExecutionStarted.make({ call })

const accepted = ToolExecutionAccepted.make({ call, result })

describe('public client background replay', () => {
  it('keeps Accepted inactive with its original receipt/timing across Started and input replays without event ids', () => {
    const state = applyAgentEvent(applyAgentEvent(initialAgentClientState, started), accepted)
    let replay = state

    for (const event of [
      started,
      ToolInputStart.make({ id: call.id, name: call.name }),
      ToolInputDelta.make({ id: call.id, delta: '{' }),
      ToolInputEnd.make({ call }),
      ToolApprovalRequested.make({
        call,
        request: ToolApprovalRequest.make({
          requestId: 'old-approval',
          toolCallId: call.id,
          call,
          policy: ToolApprovalPolicy.make({ mode: 'manual' })
        })
      })
    ]) {
      replay = applyAgentEvent(replay, event)
      expect(replay.toolRuns).toEqual(state.toolRuns)
      expect(replay.toolRuns.some(isActiveToolRun)).toBe(false)
      expect(replay.toolRuns).toMatchObject([
        { _tag: 'Accepted', result, startedAtMs: 0, endedAtMs: 0 }
      ])
    }

    // Fencing is per call, not a global ban on subsequent tool activity.
    const sibling = applyAgentEvent(replay, ToolInputStart.make({ id: 'next', name: 'work' }))
    expect(sibling.toolRuns.filter(isActiveToolRun)).toMatchObject([
      { _tag: 'InputStreaming', id: 'next' }
    ])
  })
})

it('retains Accepted across AgentEnd, submit, start and error/abort cleanup', () => {
  const transcript = [
    AssistantAgentMessage.make({ parts: [HostToolCallPart.make({ call })] }),
    ToolResultMessage.make({ ...result })
  ]

  const state = applyAgentEvent(applyAgentEvent(initialAgentClientState, started), accepted)

  let next = applyAgentEvent(
    state,
    AgentEnd.make({ messages: transcript, turns: 1, usage: zeroAgentUsage })
  )

  for (const cleanup of [
    (value: typeof next) => value,
    (value: typeof next) => submitAgentUserMessage(value, UserMessage.make({ content: 'next' })),
    (value: typeof next) => applyAgentEvent(value, AgentStart.make({})),
    markAgentError,
    markAgentAborted
  ]) {
    next = cleanup(next)
    next = applyAgentEvent(next, started)
    expect(next.toolRuns).toEqual(state.toolRuns)
    expect(next.toolRuns.some(isActiveToolRun)).toBe(false)
    expect(completedToolRuns(next.toolRuns)).toEqual([])
  }
})

it('fences active events against acknowledged hydrated transcripts without retained runs', () => {
  const messages = [
    AssistantAgentMessage.make({ parts: [HostToolCallPart.make({ call })] }),
    ToolResultMessage.make({ ...result })
  ]

  for (const event of [
    started,
    ToolInputStart.make({ id: call.id }),
    ToolInputDelta.make({ id: call.id, delta: '{' }),
    ToolInputEnd.make({ call })
  ]) {
    const state = applyAgentEvent({ ...initialAgentClientState, messages }, event)
    expect(state.toolRuns.some(isActiveToolRun)).toBe(false)
    expect(state.messages).toEqual(messages)
  }
})
