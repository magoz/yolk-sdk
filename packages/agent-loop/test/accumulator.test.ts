import { describe, expect, it } from '@effect/vitest'
import { assistantContent, assistantHostToolCalls, ToolCall } from '@yolk/protocol'
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

    expect(assistantContent(message)).toBe('Let me check.')
    expect(assistantHostToolCalls(message)).toEqual([call])
  })
})
