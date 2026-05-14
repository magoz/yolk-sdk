import { describe, expect, it } from '@effect/vitest'
import {
  assistantContent,
  assistantHostToolCalls,
  contentText,
  ToolCall,
  ToolResult
} from '@yolk/agent/protocol'
import { accumulateAssistantMessage } from '../../src/loop'
import { LLMDone, LLMProviderToolResult, LLMTextDelta, LLMToolCall } from '../../src/loop/llm-event'

describe('accumulateAssistantMessage', () => {
  it('collects text and tool calls', () => {
    const call = ToolCall.make({ id: 'call_1', name: 'lookup', params: { q: 'weather' } })
    const message = accumulateAssistantMessage([
      LLMTextDelta.make({ text: 'Let me check.' }),
      LLMToolCall.make({ call }),
      LLMDone.make({ stopReason: 'tool_use' })
    ])

    expect(assistantContent(message)).toBe('Let me check.')
    expect(assistantHostToolCalls(message)).toEqual([call])
  })

  it('preserves provider-executed tool parts in event order', () => {
    const call = ToolCall.make({ id: 'call_1', name: 'web_search', params: { q: 'weather' } })
    const result = ToolResult.make({ toolCallId: call.id, content: 'sunny' })
    const message = accumulateAssistantMessage([
      LLMTextDelta.make({ text: 'Before.' }),
      LLMProviderToolResult.make({ call, result }),
      LLMTextDelta.make({ text: 'After.' }),
      LLMDone.make({ stopReason: 'stop' })
    ])

    expect(message.parts.map(part => part._tag)).toEqual([
      'Text',
      'ProviderToolCall',
      'ProviderToolResult',
      'Text'
    ])
    expect(contentText(assistantContent(message))).toBe('Before.After.')
  })
})
