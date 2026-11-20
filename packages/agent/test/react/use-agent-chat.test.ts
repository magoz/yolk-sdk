// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from '@effect/vitest'
import { Predicate } from 'effect'
import {
  AgentAwaitingInput,
  AgentEnd,
  AgentStart,
  AssistantAgentMessage,
  AssistantTextPart,
  HostToolCallPart,
  LLMTextDelta,
  ToolApprovalRequest,
  ToolApprovalResponse,
  ToolCall,
  UserMessage,
  zeroAgentUsage,
  type AgentEvent
} from '@yolk-sdk/agent/protocol'
import {
  AgentChatDeleteTurnResult,
  AgentChatEditUserMessageResult,
  AgentChatHitlResponseResult,
  AgentChatRegenerateResult,
  AgentChatSubmitResult
} from '../../src/react/chat-actions.ts'
import { TurnDeleted, UserMessageEdited } from '../../src/react/chat-session-events.ts'
import {
  useAgentChat,
  type AgentChatTransport,
  type AgentChatTransportRequest
} from '../../src/react/use-agent-chat.ts'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type HookValue = ReturnType<typeof useAgentChat>

const readHook = (value: HookValue | undefined) => {
  if (value === undefined) {
    throw new Error('Hook not rendered')
  }

  return value
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return
    }

    await act(async () => {
      await tick()
    })
  }

  throw new Error('Timed out waiting for hook state')
}

const renderUseAgentChat = (options: Parameters<typeof useAgentChat>[0]) => {
  const container = document.createElement('div')
  const root = createRoot(container)
  let value: HookValue | undefined

  function TestComponent() {
    const hook = useAgentChat(options)

    useEffect(() => {
      value = hook
    })

    return null
  }

  act(() => {
    root.render(createElement(TestComponent))
  })

  return {
    get value() {
      return readHook(value)
    },
    unmount: () => {
      act(() => {
        root.unmount()
      })
    }
  }
}

const agentEnd = (content: string) =>
  AgentEnd.make({
    messages: [AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content })] })],
    turns: 1,
    usage: zeroAgentUsage
  })

/**
 * A pause `run:4` holding two sibling approvals; answering the first brings `run:9`, holding the
 * second; answering that ends the run.
 */
const siblingPauses = () => {
  const requests: Array<AgentChatTransportRequest> = []
  const callA = ToolCall.make({ id: 'call_a', name: 'write', params: { path: 'a' } })
  const callB = ToolCall.make({ id: 'call_b', name: 'write', params: { path: 'b' } })

  const assistant = AssistantAgentMessage.make({
    parts: [HostToolCallPart.make({ call: callA }), HostToolCallPart.make({ call: callB })]
  })

  const approvalOf = (call: ToolCall) =>
    ToolApprovalRequest.make({ requestId: `approval:${call.id}`, toolCallId: call.id, call })

  const approve = (call: ToolCall) =>
    ToolApprovalResponse.make({
      requestId: `approval:${call.id}`,
      toolCallId: call.id,
      decision: 'approved',
      source: 'user'
    })

  const bothPending: readonly [ToolApprovalRequest, ToolApprovalRequest] = [
    approvalOf(callA),
    approvalOf(callB)
  ]

  const secondPending: readonly [ToolApprovalRequest] = [approvalOf(callB)]
  const pauseFields = { messages: [assistant], turns: 1, usage: zeroAgentUsage }
  const first = AgentAwaitingInput.make({ eventId: 'run:4', requests: bothPending, ...pauseFields })

  const second = AgentAwaitingInput.make({
    eventId: 'run:9',
    requests: secondPending,
    ...pauseFields
  })

  const transport: AgentChatTransport = async function* (request) {
    requests.push(request)

    if (requests.length === 1) {
      yield AgentStart.make({ eventId: 'run:0' })
      yield first

      return
    }

    yield requests.length === 2 ? second : agentEnd('approved')
  }

  type Hook = ReturnType<typeof renderUseAgentChat>

  const answerFirstSibling = async (hook: Hook) => {
    await act(async () => {
      hook.value.submitText('write both')
      await tick()
    })
    await waitFor(() => Predicate.isTagged(hook.value.status, 'Blocked'))

    await act(async () => {
      hook.value.submitToolApprovalResponse(approve(callA))
      await tick()
    })
    await waitFor(() => requests.length === 2 && Predicate.isTagged(hook.value.status, 'Blocked'))
  }

  const answerSecondSibling = async (hook: Hook) => {
    await act(async () => {
      hook.value.submitToolApprovalResponse(approve(callB))
      await tick()
    })
    await waitFor(() => Predicate.isTagged(hook.value.status, 'Done'))
  }

  return { requests, transport, first, second, answerFirstSibling, answerSecondSibling }
}

describe('useAgentChat', () => {
  it('submits text through an injected transport and applies streamed events', async () => {
    const requests: Array<AgentChatTransportRequest> = []
    const events: Array<AgentEvent> = []

    const transport: AgentChatTransport = async function* (request) {
      requests.push(request)
      yield AgentStart.make({})
      yield LLMTextDelta.make({ text: 'hello' })
      yield agentEnd('hello')
    }

    const hook = renderUseAgentChat({
      sessionId: 'session-1',
      transport,
      onEvent: event => events.push(event)
    })

    await act(async () => {
      const result = hook.value.submitText(' hello ')
      const message = UserMessage.make({ content: 'hello' })
      expect(result).toEqual(
        AgentChatSubmitResult.Submitted({
          content: 'hello',
          message,
          messages: [message]
        })
      )
      await tick()
    })
    await waitFor(() => Predicate.isTagged(hook.value.status, 'Done'))

    expect(requests).toHaveLength(1)
    expect(requests[0]?.sessionId).toBe('session-1')
    expect(requests[0]?.messages).toEqual([UserMessage.make({ content: 'hello' })])
    expect(events.map(event => event._tag)).toEqual(['AgentStart', 'LLMTextDelta', 'AgentEnd'])
    expect(hook.value.chatMessages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(hook.value.messages).toEqual([
      UserMessage.make({ content: 'hello' }),
      AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'hello' })] })
    ])

    hook.unmount()
  })

  it('ignores blank submits', () => {
    const requests: Array<AgentChatTransportRequest> = []

    const transport: AgentChatTransport = async function* (request) {
      requests.push(request)
    }

    const hook = renderUseAgentChat({ sessionId: 'session-1', transport })

    act(() => {
      expect(hook.value.submitText('   ')).toEqual(AgentChatSubmitResult.Ignored())
    })

    expect(requests).toEqual([])
    expect(hook.value.status._tag).toBe('Idle')

    hook.unmount()
  })

  it('marks runs aborted when stopped', async () => {
    const transport: AgentChatTransport = async function* (request) {
      yield AgentStart.make({})
      await new Promise<void>(resolve => {
        request.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      const error = new Error('aborted')
      Object.defineProperty(error, 'name', { value: 'AbortError' })
      throw error
    }

    const hook = renderUseAgentChat({ sessionId: 'session-1', transport })

    await act(async () => {
      hook.value.submitText('hello')
      await tick()
    })
    expect(hook.value.status._tag).toBe('Working')
    expect(hook.value.deleteTurn('message-0-user')).toEqual(AgentChatDeleteTurnResult.Ignored())

    await act(async () => {
      hook.value.stop()
      await tick()
    })
    await waitFor(() => Predicate.isTagged(hook.value.status, 'Idle'))

    hook.unmount()
  })

  it('reports injected transport failures without treating them as abort', async () => {
    const messages: Array<string> = []

    const transport: AgentChatTransport = async function* () {
      throw new Error('upstream failed')
    }

    const hook = renderUseAgentChat({
      sessionId: 'session-1',
      transport,
      onError: message => messages.push(message)
    })

    await act(async () => {
      hook.value.submitText('hello')
      await tick()
    })
    await waitFor(() => Predicate.isTagged(hook.value.status, 'Failed'))

    expect(hook.value.status).toMatchObject({ _tag: 'Failed', message: 'upstream failed' })
    expect(messages).toEqual(['upstream failed'])

    hook.unmount()
  })

  it('uses a fixed message when the transport rejects with a non-Error value', async () => {
    const messages: Array<string> = []

    const transport: AgentChatTransport = async function* () {
      throw 'forged'
    }

    const hook = renderUseAgentChat({
      sessionId: 'session-1',
      transport,
      onError: message => messages.push(message)
    })

    await act(async () => {
      hook.value.submitText('hello')
      await tick()
    })
    await waitFor(() => Predicate.isTagged(hook.value.status, 'Failed'))

    expect(hook.value.status).toMatchObject({ _tag: 'Failed', message: 'Agent request failed' })
    expect(messages).toEqual(['Agent request failed'])

    hook.unmount()
  })

  it('submits HITL responses through the current transcript', async () => {
    const requests: Array<AgentChatTransportRequest> = []
    const call = ToolCall.make({ id: 'call_1', name: 'weather', params: { city: 'Paris' } })
    const assistant = AssistantAgentMessage.make({ parts: [HostToolCallPart.make({ call })] })

    const approvalRequest = ToolApprovalRequest.make({
      requestId: 'approval:call_1',
      toolCallId: call.id,
      call
    })

    const approvalResponse = ToolApprovalResponse.make({
      requestId: approvalRequest.requestId,
      toolCallId: call.id,
      decision: 'approved',
      source: 'user'
    })

    const transport: AgentChatTransport = async function* (request) {
      requests.push(request)

      if (request.hitlResponses === undefined) {
        yield AgentStart.make({})
        yield AgentAwaitingInput.make({
          requests: [approvalRequest],
          messages: [assistant],
          turns: 1,
          usage: zeroAgentUsage
        })

        return
      }

      yield AgentStart.make({})
      yield agentEnd('approved')
    }

    const hook = renderUseAgentChat({ sessionId: 'session-1', transport })

    await act(async () => {
      hook.value.submitText('weather')
      await tick()
    })
    await waitFor(() => Predicate.isTagged(hook.value.status, 'Blocked'))

    await act(async () => {
      const result = hook.value.submitToolApprovalResponse(approvalResponse)
      expect(result).toEqual(
        AgentChatHitlResponseResult.Submitted({
          response: approvalResponse,
          messages: [UserMessage.make({ content: 'weather' }), assistant]
        })
      )
      await tick()
    })
    await waitFor(() => Predicate.isTagged(hook.value.status, 'Done'))

    expect(requests).toHaveLength(2)
    expect(requests[1]?.messages).toEqual([UserMessage.make({ content: 'weather' }), assistant])
    expect(requests[1]?.hitlResponses).toEqual([approvalResponse])

    hook.unmount()
  })

  it('puts the pause of the latest AgentAwaitingInput holding the request on each answer', async () => {
    const requests: Array<AgentChatTransportRequest> = []
    const call = ToolCall.make({ id: 'call_1', name: 'weather', params: { city: 'Paris' } })
    const assistant = AssistantAgentMessage.make({ parts: [HostToolCallPart.make({ call })] })

    const approvalRequest = ToolApprovalRequest.make({
      requestId: 'approval:call_1',
      toolCallId: call.id,
      call
    })

    const approvalResponse = ToolApprovalResponse.make({
      requestId: approvalRequest.requestId,
      toolCallId: call.id,
      decision: 'approved',
      source: 'user'
    })

    const paused = (eventId: string) =>
      AgentAwaitingInput.make({
        eventId,
        requests: [approvalRequest],
        messages: [assistant],
        turns: 1,
        usage: zeroAgentUsage
      })

    const transport: AgentChatTransport = async function* (request) {
      requests.push(request)

      // Start: the first pause. First answer: the request pends again under a new pause.
      if (requests.length === 1) {
        yield AgentStart.make({ eventId: 'run:0' })
        yield paused('run:4')

        return
      }

      if (requests.length === 2) {
        yield paused('run:9')

        return
      }

      yield agentEnd('approved')
    }

    const hook = renderUseAgentChat({ sessionId: 'session-1', transport })

    await act(async () => {
      hook.value.submitText('weather')
      await tick()
    })
    await waitFor(() => Predicate.isTagged(hook.value.status, 'Blocked'))

    await act(async () => {
      hook.value.submitToolApprovalResponse(approvalResponse)
      await tick()
    })
    await waitFor(() => requests.length === 2 && Predicate.isTagged(hook.value.status, 'Blocked'))

    await act(async () => {
      hook.value.submitToolApprovalResponse(approvalResponse)
      await tick()
    })
    await waitFor(() => Predicate.isTagged(hook.value.status, 'Done'))

    expect(requests.map(request => request.pause)).toEqual([undefined, 'run:4', 'run:9'])
    expect('pause' in (requests[0] ?? {})).toBe(false)

    hook.unmount()
  })

  it('names the later pause of a sibling request after its first sibling was answered', async () => {
    const pauses = siblingPauses()
    const hook = renderUseAgentChat({ sessionId: 'session-1', transport: pauses.transport })

    await pauses.answerFirstSibling(hook)
    await pauses.answerSecondSibling(hook)

    expect(pauses.requests.map(request => request.pause)).toEqual([undefined, 'run:4', 'run:9'])

    hook.unmount()
  })

  it('names the latest pause after a replay from the start re-reads a seen one', async () => {
    const pauses = siblingPauses()
    const hook = renderUseAgentChat({ sessionId: 'session-1', transport: pauses.transport })

    await pauses.answerFirstSibling(hook)

    // The answer cleared the seen ids: the replay reads `run:4` as new and `run:9` as seen.
    act(() => {
      hook.value.applyEvent(AgentStart.make({ eventId: 'run:0' }))
      hook.value.applyEvent(pauses.first)
      hook.value.applyEvent(pauses.second)
    })

    expect(Predicate.isTagged(hook.value.status, 'Blocked')).toBe(true)

    await pauses.answerSecondSibling(hook)

    expect(pauses.requests.map(request => request.pause)).toEqual([undefined, 'run:4', 'run:9'])

    hook.unmount()
  })

  it('learns the pause from replayed events and sends none for an unnamed pause', async () => {
    const requests: Array<AgentChatTransportRequest> = []
    const call = ToolCall.make({ id: 'call_1', name: 'weather', params: { city: 'Paris' } })
    const assistant = AssistantAgentMessage.make({ parts: [HostToolCallPart.make({ call })] })

    const approvalRequest = ToolApprovalRequest.make({
      requestId: 'approval:call_1',
      toolCallId: call.id,
      call
    })

    const approvalResponse = ToolApprovalResponse.make({
      requestId: approvalRequest.requestId,
      toolCallId: call.id,
      decision: 'approved',
      source: 'user'
    })

    const pauseRequests: readonly [ToolApprovalRequest] = [approvalRequest]

    const pauseFields = {
      requests: pauseRequests,
      messages: [assistant],
      turns: 1,
      usage: zeroAgentUsage
    }

    const paused = (eventId: string) => AgentAwaitingInput.make({ eventId, ...pauseFields })

    const transport: AgentChatTransport = async function* (request) {
      requests.push(request)
      // An unnamed pause holds the request again: the answer names no stale pause.
      yield requests.length === 1 ? AgentAwaitingInput.make(pauseFields) : agentEnd('approved')
    }

    const hook = renderUseAgentChat({
      sessionId: 'session-1',
      initialMessages: [UserMessage.make({ content: 'weather' })],
      transport
    })

    // A reconnect replays the run: the second copy of the pause is deduped by its eventId.
    act(() => {
      hook.value.applyEvent(AgentStart.make({ eventId: 'run:0' }))
      hook.value.applyEvent(paused('run:4'))
      hook.value.applyEvent(AgentStart.make({ eventId: 'run:0' }))
      hook.value.applyEvent(paused('run:4'))
    })

    expect(Predicate.isTagged(hook.value.status, 'Blocked')).toBe(true)

    await act(async () => {
      hook.value.submitToolApprovalResponse(approvalResponse)
      await tick()
    })
    await waitFor(() => Predicate.isTagged(hook.value.status, 'Blocked') && requests.length === 1)

    await act(async () => {
      hook.value.submitToolApprovalResponse(approvalResponse)
      await tick()
    })
    await waitFor(() => Predicate.isTagged(hook.value.status, 'Done'))

    expect(requests.map(request => request.pause)).toEqual(['run:4', undefined])

    hook.unmount()
  })

  it('marks orphan running state aborted when stopped', async () => {
    const transport: AgentChatTransport = async function* () {
      yield AgentStart.make({})
    }

    const hook = renderUseAgentChat({ sessionId: 'session-1', transport })

    await act(async () => {
      hook.value.submitText('hello')
      await tick()
    })
    expect(hook.value.status._tag).toBe('Working')

    await act(async () => {
      hook.value.stop()
      await tick()
    })

    expect(hook.value.status._tag).toBe('Idle')

    hook.unmount()
  })

  it('deletes a persisted turn without sending transport requests', () => {
    const requests: Array<AgentChatTransportRequest> = []

    const transport: AgentChatTransport = async function* (request) {
      requests.push(request)
    }

    const hook = renderUseAgentChat({
      sessionId: 'session-1',
      transport,
      initialMessages: [
        UserMessage.make({ content: 'one' }),
        AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'first' })] }),
        UserMessage.make({ content: 'two' })
      ]
    })

    expect(hook.value.state.sessionEvents).toEqual([])

    act(() => {
      expect(hook.value.deleteTurn('missing')).toEqual(AgentChatDeleteTurnResult.Ignored())
      expect(hook.value.deleteTurn('message-1-assistant')).toEqual(
        AgentChatDeleteTurnResult.Deleted({
          turnStartMessageId: 'message-0-user',
          deletedMessageIds: ['message-0-user', 'message-1-assistant']
        })
      )
    })

    expect(requests).toEqual([])
    expect(hook.value.messages).toEqual([UserMessage.make({ content: 'two' })])
    expect(hook.value.state.sessionEvents.at(-1)).toEqual(
      TurnDeleted.make({
        turnStartMessageId: 'message-0-user',
        deletedMessageIds: ['message-0-user', 'message-1-assistant']
      })
    )

    hook.unmount()
  })

  it('regenerates from a selected assistant message', async () => {
    const requests: Array<AgentChatTransportRequest> = []

    const transport: AgentChatTransport = async function* (request) {
      requests.push(request)
      yield AgentStart.make({})
      yield agentEnd('again')
    }

    const hook = renderUseAgentChat({
      sessionId: 'session-1',
      transport,
      initialMessages: [
        UserMessage.make({ content: 'one' }),
        AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'first' })] })
      ]
    })

    await act(async () => {
      const result = hook.value.regenerateFrom('message-1-assistant')
      expect(result).toEqual(
        AgentChatRegenerateResult.Regenerated({
          messageId: 'message-1-assistant',
          messages: [UserMessage.make({ content: 'one' })]
        })
      )
      await tick()
    })
    await waitFor(() => Predicate.isTagged(hook.value.status, 'Done'))

    expect(requests).toHaveLength(1)
    expect(requests[0]?.messages).toEqual([UserMessage.make({ content: 'one' })])
    expect(hook.value.messages).toEqual([
      UserMessage.make({ content: 'one' }),
      AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'again' })] })
    ])

    hook.unmount()
  })

  it('edits a user message and reruns from the edited transcript', async () => {
    const requests: Array<AgentChatTransportRequest> = []

    const transport: AgentChatTransport = async function* (request) {
      requests.push(request)
      yield AgentStart.make({})
      yield agentEnd('edited reply')
    }

    const hook = renderUseAgentChat({
      sessionId: 'session-1',
      transport,
      initialMessages: [
        UserMessage.make({ content: 'one' }),
        AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'first' })] }),
        UserMessage.make({ content: 'two' }),
        AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'second' })] })
      ]
    })

    await act(async () => {
      const result = hook.value.editUserMessage('message-2-user', 'updated')
      expect(result).toEqual(
        AgentChatEditUserMessageResult.Edited({
          messageId: 'message-2-user',
          messages: [
            UserMessage.make({ content: 'one' }),
            AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'first' })] }),
            UserMessage.make({ content: 'updated' })
          ]
        })
      )
      await tick()
    })
    await waitFor(() => Predicate.isTagged(hook.value.status, 'Done'))

    expect(requests).toHaveLength(1)
    expect(requests[0]?.messages).toEqual([
      UserMessage.make({ content: 'one' }),
      AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'first' })] }),
      UserMessage.make({ content: 'updated' })
    ])
    expect(hook.value.messages).toEqual([
      UserMessage.make({ content: 'one' }),
      AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'first' })] }),
      UserMessage.make({ content: 'updated' }),
      AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'edited reply' })] })
    ])
    expect(hook.value.state.sessionEvents.at(-1)).toEqual(
      UserMessageEdited.make({
        messageId: 'message-2-user',
        content: 'updated',
        keptMessageIds: ['message-0-user', 'message-1-assistant', 'message-2-user']
      })
    )

    hook.unmount()
  })

  it('ignores missing, non-user, empty, and idle HITL mutations', () => {
    const requests: Array<AgentChatTransportRequest> = []

    const transport: AgentChatTransport = async function* (request) {
      requests.push(request)
    }

    const hook = renderUseAgentChat({
      sessionId: 'session-1',
      transport,
      initialMessages: [
        UserMessage.make({ content: 'one' }),
        AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'first' })] })
      ]
    })

    const approvalResponse = ToolApprovalResponse.make({
      requestId: 'approval:call_1',
      toolCallId: 'call_1',
      decision: 'approved',
      source: 'user'
    })

    act(() => {
      expect(hook.value.regenerateFrom('missing')).toEqual(AgentChatRegenerateResult.Ignored())
      expect(hook.value.editUserMessage('missing', 'updated')).toEqual(
        AgentChatEditUserMessageResult.Ignored()
      )
      expect(hook.value.editUserMessage('message-1-assistant', 'updated')).toEqual(
        AgentChatEditUserMessageResult.Ignored()
      )
      expect(hook.value.editUserMessage('message-0-user', '')).toEqual(
        AgentChatEditUserMessageResult.Ignored()
      )
      expect(hook.value.submitToolApprovalResponse(approvalResponse)).toEqual(
        AgentChatHitlResponseResult.Ignored()
      )
    })

    expect(requests).toEqual([])
    expect(hook.value.status._tag).toBe('Idle')
    expect(hook.value.messages).toEqual([
      UserMessage.make({ content: 'one' }),
      AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'first' })] })
    ])

    hook.unmount()
  })
})
