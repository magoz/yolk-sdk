import { act, createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from '@effect/vitest'
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
  useAgentChat,
  type AgentChatTransport,
  type AgentChatTransportRequest
} from './use-agent-chat'

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
      expect(result._tag).toBe('Submitted')
      await tick()
    })
    await waitFor(() => hook.value.status === 'done')

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
      expect(hook.value.submitText('   ')).toEqual({ _tag: 'Ignored' })
    })

    expect(requests).toEqual([])
    expect(hook.value.status).toBe('idle')

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
    expect(hook.value.status).toBe('running')

    await act(async () => {
      hook.value.stop()
      await tick()
    })
    await waitFor(() => hook.value.status === 'aborted')

    expect(hook.value.error).toBeNull()

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
    await waitFor(() => hook.value.status === 'waiting')

    await act(async () => {
      const result = hook.value.submitToolApprovalResponse(approvalResponse)
      expect(result._tag).toBe('Submitted')
      await tick()
    })
    await waitFor(() => hook.value.status === 'done')

    expect(requests).toHaveLength(2)
    expect(requests[1]?.messages).toEqual([UserMessage.make({ content: 'weather' }), assistant])
    expect(requests[1]?.hitlResponses).toEqual([approvalResponse])

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
    expect(hook.value.status).toBe('running')

    await act(async () => {
      hook.value.stop()
      await tick()
    })

    expect(hook.value.status).toBe('aborted')
    expect(hook.value.error).toBeNull()

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
      expect(hook.value.deleteTurn('message-1-assistant')).toEqual({
        _tag: 'Deleted',
        turnStartMessageId: 'message-0-user',
        deletedMessageIds: ['message-0-user', 'message-1-assistant']
      })
    })

    expect(requests).toEqual([])
    expect(hook.value.messages).toEqual([UserMessage.make({ content: 'two' })])
    expect(hook.value.state.sessionEvents.at(-1)).toEqual({
      _tag: 'TurnDeleted',
      turnStartMessageId: 'message-0-user',
      deletedMessageIds: ['message-0-user', 'message-1-assistant']
    })

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
      expect(result._tag).toBe('Regenerated')
      await tick()
    })
    await waitFor(() => hook.value.status === 'done')

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
      expect(result._tag).toBe('Edited')
      await tick()
    })
    await waitFor(() => hook.value.status === 'done')

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
    expect(hook.value.state.sessionEvents.at(-1)).toEqual({
      _tag: 'UserMessageEdited',
      messageId: 'message-2-user',
      content: 'updated',
      keptMessageIds: ['message-0-user', 'message-1-assistant', 'message-2-user']
    })

    hook.unmount()
  })
})
