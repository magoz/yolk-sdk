// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Option, Predicate } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentAwaitingInput,
  AgentEnd,
  AgentStart,
  AssistantAgentMessage,
  AssistantTextPart,
  HostToolCallPart,
  InputRequest,
  InputResponse,
  InputRequested,
  InputSubmitted,
  InputCancelled,
  ToolCall,
  UserMessage,
  zeroAgentUsage
} from '@yolk-sdk/agent/protocol'
import { AgentChatHitlResponseResult } from '../../src/react/chat-actions.ts'
import {
  applyAgentEventToChatMessages,
  buildAgentChatItems,
  toAgentMessages
} from '../../src/react/index.ts'
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

const call = ToolCall.make({ id: 'call_word', name: 'word', params: {} })

const inputRequest = InputRequest.make({
  requestId: 'input:word:call_word',
  toolCallId: call.id,
  call,
  input: { kind: 'text-field', title: 'Word' }
})

const submittedResponse = InputResponse.make({
  requestId: 'input:word:call_word',
  toolCallId: call.id,
  outcome: 'submitted',
  source: 'user',
  data: 'kind'
})

const findToolCall = (messages: Parameters<typeof toAgentMessages>[0]) =>
  messages.flatMap(message => message.parts).find(part => Predicate.isTagged(part, 'ToolCall'))

describe('input headless state', () => {
  it('projects pending input requests onto tool call parts', () => {
    const messages = applyAgentEventToChatMessages(
      [],
      InputRequested.make({ request: inputRequest })
    )

    const toolCall = findToolCall(messages)

    if (!Predicate.isTagged(toolCall, 'ToolCall')) {
      throw new Error('Expected ToolCall part')
    }

    if (!Predicate.isTagged(toolCall.state, 'InputRequested')) {
      throw new Error('Expected InputRequested tool call part')
    }

    expect(toolCall.call).toEqual(call)

    expect(toolCall.state.request).toEqual(inputRequest)
  })

  it('preserves the request on submitted input and replays validated data', () => {
    const requested = applyAgentEventToChatMessages(
      [],
      InputRequested.make({ request: inputRequest })
    )

    const submittedMessages = applyAgentEventToChatMessages(
      requested,
      InputSubmitted.make({ response: submittedResponse })
    )

    const toolCall = findToolCall(submittedMessages)

    if (!Predicate.isTagged(toolCall, 'ToolCall')) {
      throw new Error('Expected ToolCall part')
    }

    if (!Predicate.isTagged(toolCall.state, 'InputSubmitted')) {
      throw new Error('Expected InputSubmitted tool call part')
    }

    expect(toolCall.state.request).toEqual(inputRequest)

    const protocol = toAgentMessages(submittedMessages)

    const result = protocol.find(message => Predicate.isTagged(message, 'ToolResult'))

    if (!Predicate.isTagged(result, 'ToolResult')) {
      throw new Error('Expected tool result message')
    }

    expect(result.toolCallId).toBe('call_word')

    expect(result.isError).toBeUndefined()

    expect(result.structuredContent).toEqual({
      type: 'input_response',
      name: 'word',
      outcome: 'submitted',
      data: 'kind',
      source: 'user'
    })
  })

  it('replays cancelled input as a model-visible error', () => {
    const requested = applyAgentEventToChatMessages(
      [],
      InputRequested.make({ request: inputRequest })
    )

    const cancelled = InputResponse.make({
      requestId: 'input:word:call_word',
      toolCallId: call.id,
      outcome: 'cancelled',
      source: 'user',
      reason: 'not now'
    })

    const cancelledMessages = applyAgentEventToChatMessages(
      requested,
      InputCancelled.make({ response: cancelled })
    )

    const protocol = toAgentMessages(cancelledMessages)

    const result = protocol.find(message => Predicate.isTagged(message, 'ToolResult'))

    if (!Predicate.isTagged(result, 'ToolResult')) {
      throw new Error('Expected tool result message')
    }

    expect(result.isError).toBe(true)

    expect(result.content).toBe('Input cancelled: not now')
  })

  it('builds chat items for pending and submitted input runs', () => {
    const requested = applyAgentEventToChatMessages(
      [],
      InputRequested.make({ request: inputRequest })
    )

    const pendingItems = buildAgentChatItems({
      messages: requested,
      isRunning: false,
      activeToolLabel: Option.none()
    })

    const pendingRun = pendingItems.find(part => Predicate.isTagged(part, 'ToolRun'))

    if (!Predicate.isTagged(pendingRun, 'ToolRun')) {
      throw new Error('Expected ToolRun chat item')
    }

    if (!Predicate.isTagged(pendingRun.state, 'InputRequested')) {
      throw new Error('Expected InputRequested chat item')
    }

    const submittedMessages = applyAgentEventToChatMessages(
      requested,
      InputSubmitted.make({ response: submittedResponse })
    )

    const submittedItems = buildAgentChatItems({
      messages: submittedMessages,
      isRunning: false,
      activeToolLabel: Option.none()
    })

    const submittedRun = submittedItems.find(part => Predicate.isTagged(part, 'ToolRun'))

    if (!Predicate.isTagged(submittedRun, 'ToolRun')) {
      throw new Error('Expected ToolRun chat item')
    }

    if (!Predicate.isTagged(submittedRun.state, 'InputSubmitted')) {
      throw new Error('Expected InputSubmitted chat item')
    }
  })

  it('keeps rejected input pending for correction without replaying optimistic data', async () => {
    const requests: Array<AgentChatTransportRequest> = []
    const assistant = AssistantAgentMessage.make({ parts: [HostToolCallPart.make({ call })] })

    const transport: AgentChatTransport = async function* (request) {
      requests.push(request)
      yield AgentStart.make({})
      const response = request.hitlResponses?.[0]

      if (!Predicate.isTagged(response, 'InputResponse') || response.data !== 'kind') {
        yield InputRequested.make({ request: inputRequest })
        yield AgentAwaitingInput.make({
          requests: [inputRequest],
          messages: request.hitlResponses === undefined ? [assistant] : [],
          turns: 1,
          usage: zeroAgentUsage
        })

        return
      }

      yield InputSubmitted.make({ response })
      yield AgentEnd.make({ messages: [], turns: 1, usage: zeroAgentUsage })
    }

    const hook = renderUseAgentChat({ sessionId: 'correction', transport })

    try {
      await act(async () => {
        hook.value.submitText('word')
        await tick()
      })
      await waitFor(() => hook.value.status === 'waiting')
      await act(async () => {
        hook.value.submitInputResponse(
          InputResponse.make({ ...submittedResponse, data: 'invalid' })
        )
        await tick()
      })
      await waitFor(() => hook.value.status === 'waiting')
      expect(findToolCall(hook.value.chatMessages)?.state._tag).toBe('InputRequested')
      expect(hook.value.messages.some(message => Predicate.isTagged(message, 'ToolResult'))).toBe(
        false
      )
      await act(async () => {
        hook.value.submitInputResponse(submittedResponse)
        await tick()
      })
      await waitFor(() => hook.value.status === 'done')
      expect(requests).toHaveLength(3)
      expect(requests[2]?.messages.some(message => Predicate.isTagged(message, 'ToolResult'))).toBe(
        false
      )
      expect(
        hook.value.messages.find(message => Predicate.isTagged(message, 'ToolResult'))
      ).toMatchObject({ structuredContent: { data: 'kind' } })
    } finally {
      hook.unmount()
    }
  })

  it('does not turn an interrupted submission into a tool result and recovers from replay', async () => {
    const assistant = AssistantAgentMessage.make({ parts: [HostToolCallPart.make({ call })] })

    const pending = AgentAwaitingInput.make({
      requests: [inputRequest],
      messages: [assistant],
      turns: 1,
      usage: zeroAgentUsage
    })

    const transport: AgentChatTransport = async function* (request) {
      if (request.hitlResponses !== undefined) throw new Error('Disconnected before acceptance')
      yield pending
    }

    const hook = renderUseAgentChat({ sessionId: 'reconnect', transport })

    try {
      await act(async () => {
        hook.value.submitText('word')
        await tick()
      })
      await waitFor(() => hook.value.status === 'waiting')
      await act(async () => {
        hook.value.submitInputResponse(submittedResponse)
        await tick()
      })
      await waitFor(() => hook.value.status === 'error')
      expect(hook.value.messages.some(message => Predicate.isTagged(message, 'ToolResult'))).toBe(
        false
      )
      await act(async () => {
        hook.value.applyEvent(pending)
        await tick()
      })
      expect(hook.value.status).toBe('waiting')
      expect(hook.value.canSubmitHitlResponse()).toBe(true)
      expect(findToolCall(hook.value.chatMessages)?.state._tag).toBe('InputRequested')
    } finally {
      hook.unmount()
    }
  })

  it('submits input responses through the hook while waiting', async () => {
    const requests: Array<AgentChatTransportRequest> = []

    const assistant = AssistantAgentMessage.make({ parts: [HostToolCallPart.make({ call })] })

    const transport: AgentChatTransport = async function* (request: AgentChatTransportRequest) {
      requests.push(request)

      if (request.hitlResponses === undefined) {
        yield AgentStart.make({})

        yield AgentAwaitingInput.make({
          requests: [inputRequest],
          messages: [assistant],
          turns: 1,
          usage: zeroAgentUsage
        })

        return
      }

      yield AgentStart.make({})

      yield AgentEnd.make({
        messages: [
          AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'thanks' })] })
        ],
        turns: 2,
        usage: zeroAgentUsage
      })
    }

    const hook = renderUseAgentChat({ sessionId: 'session-1', transport })

    await act(async () => {
      hook.value.submitText('give me a word')

      await tick()
    })

    await waitFor(() => hook.value.status === 'waiting')

    expect(hook.value.canSubmitHitlResponse()).toBe(true)

    await act(async () => {
      const result = hook.value.submitInputResponse(submittedResponse)

      expect(result).toEqual(
        AgentChatHitlResponseResult.Submitted({
          response: submittedResponse,
          messages: [UserMessage.make({ content: 'give me a word' }), assistant]
        })
      )

      await tick()
    })

    await waitFor(() => hook.value.status === 'done')

    expect(requests).toHaveLength(2)

    expect(requests[1]?.hitlResponses).toEqual([submittedResponse])

    hook.unmount()
  })
})
