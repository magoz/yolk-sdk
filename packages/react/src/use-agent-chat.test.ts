import { act, createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentEnd,
  AgentStart,
  AssistantAgentMessage,
  LLMTextDelta,
  UserMessage,
  type AgentEvent
} from '@yolk/protocol'
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
    messages: [AssistantAgentMessage.make({ content, toolCalls: [] })],
    turns: 1,
    usage: { input: 1, output: 1 }
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
      AssistantAgentMessage.make({ content: 'hello', toolCalls: [] })
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
})
