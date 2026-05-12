import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  AssistantTextPart,
  HostToolCallPart,
  ToolCall,
  ToolResultMessage,
  UserMessage,
  type AgentMessage
} from '@yolk/protocol'
import {
  compactAgentMessages,
  contextCompactionStrategy,
  estimateAgentMessagesTokens
} from './context-transformer'

const longText = 'context '.repeat(6_000)

const user = (content: string) => UserMessage.make({ content })
const assistant = (content: string) =>
  AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content })] })

const toolCallingAssistant = () =>
  AssistantAgentMessage.make({
    parts: [HostToolCallPart.make({ call: ToolCall.make({ id: 'call_1', name: 'lookup', params: {} }) })]
  })

const toolResult = () => ToolResultMessage.make({ toolCallId: 'call_1', content: 'result' })

describe('agent context transformer', () => {
  it('leaves small transcripts unchanged', () => {
    const messages = [user('hello'), assistant('hi')]
    const result = compactAgentMessages(messages)

    expect(result.messages).toEqual(messages)
    expect(result.events).toEqual([])
  })

  it('compacts old transcript messages and emits lifecycle events', () => {
    const recent = [user('recent question'), assistant('recent answer')]
    const oldMessages = Array.from({ length: 18 }, (_, index) =>
      index % 2 === 0 ? user(longText) : assistant(longText)
    )
    const messages: ReadonlyArray<AgentMessage> = [...oldMessages, ...recent]
    const result = compactAgentMessages(messages)

    expect(result.events).toMatchObject([
      { _tag: 'CompactionStart', strategy: contextCompactionStrategy },
      { _tag: 'CompactionEnd', strategy: contextCompactionStrategy }
    ])
    expect(result.messages.length).toBeLessThan(messages.length)
    expect(result.messages.slice(-recent.length)).toEqual(recent)
    expect(estimateAgentMessagesTokens(result.messages)).toBeLessThan(
      estimateAgentMessagesTokens(messages)
    )
  })

  it('keeps tool results attached to recent tool calls', () => {
    const messages: ReadonlyArray<AgentMessage> = [
      user(longText),
      assistant(longText),
      user(longText),
      assistant(longText),
      user('use tool'),
      toolCallingAssistant(),
      toolResult()
    ]
    const result = compactAgentMessages(messages)

    expect(result.messages.slice(-3)).toEqual(messages.slice(-3))
  })
})
