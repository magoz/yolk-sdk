import { describe, expect, it } from '@effect/vitest'
import { ToolCall } from '@yolk/protocol'
import { accumulateAssistantMessage } from '../src'
import { LLMDone, LLMTextDelta, LLMToolCall } from '../src/llm-event'

describe('accumulateAssistantMessage', () => {
  it('collects text and tool calls', () => {
    const call = ToolCall.make({ id: 'call_1', name: 'lookup', params: { q: 'weather' } })
    const message = accumulateAssistantMessage([
      LLMTextDelta.make({ text: 'Let me check.' }),
      LLMToolCall.make({ call }),
      LLMDone.make({ stopReason: 'tool_use' })
    ])

    expect(message.content).toBe('Let me check.')
    expect(message.toolCalls).toEqual([call])
  })
})
