import { describe, expect, it } from '@effect/vitest'
import { Predicate } from 'effect'
import {
  assistantContent,
  assistantHostToolCalls,
  assistantReasoningText,
  AssistantTextPart,
  contentText,
  ToolCall,
  ToolResult
} from '@yolk-sdk/agent/protocol'
import {
  accumulateAssistantMessage,
  collectReasoning,
  collectText,
  collectToolCalls
} from '../../src/loop'
import { applyAssistantLlmEvent } from '../../src/loop/accumulator.ts'
import {
  LLMDone,
  LLMProviderToolResult,
  LLMReasoningDelta,
  LLMTextDelta,
  LLMToolCall,
  LLMToolInputDelta,
  LLMToolInputStart,
  LLMUsage
} from '../../src/loop/llm-event'
import { AgentInputUsage, AgentOutputUsage, AgentUsage } from '../../src/protocol/usage.ts'

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

  it('coalesces consecutive text and reasoning and splits nonconsecutive runs', () => {
    const call = ToolCall.make({ id: 'call_1', name: 'lookup', params: { q: 'weather' } })
    const result = ToolResult.make({ toolCallId: 'call_search', content: 'sunny' })

    const searchCall = ToolCall.make({
      id: 'call_search',
      name: 'web_search',
      params: { q: 'weather' }
    })

    const message = accumulateAssistantMessage([
      LLMTextDelta.make({ text: 'A' }),
      LLMTextDelta.make({ text: 'B' }),
      LLMReasoningDelta.make({ text: 'r1' }),
      LLMReasoningDelta.make({ text: 'r2' }),
      LLMTextDelta.make({ text: 'C' }),
      LLMToolCall.make({ call }),
      LLMTextDelta.make({ text: 'D' }),
      LLMReasoningDelta.make({ text: 'r3' }),
      LLMProviderToolResult.make({ call: searchCall, result }),
      LLMReasoningDelta.make({ text: 'r4' })
    ])

    expect(message.parts.map(part => part._tag)).toEqual([
      'Text',
      'Reasoning',
      'Text',
      'HostToolCall',
      'Text',
      'Reasoning',
      'ProviderToolCall',
      'ProviderToolResult',
      'Reasoning'
    ])
    expect(contentText(assistantContent(message))).toBe('ABCD')
    expect(assistantReasoningText(message)).toBe('r1r2r3r4')
  })

  it('ignores Done, usage, and tool-input events', () => {
    const usage = AgentUsage.make({
      input: AgentInputUsage.make({ total: 1 }),
      output: AgentOutputUsage.make({ total: 2 })
    })

    const message = accumulateAssistantMessage([
      LLMToolInputStart.make({ id: 'call_1', name: 'lookup' }),
      LLMToolInputDelta.make({ id: 'call_1', delta: '{' }),
      LLMUsage.make({ usage }),
      LLMTextDelta.make({ text: 'Hello' }),
      LLMDone.make({ stopReason: 'stop' })
    ])

    expect(message.parts.map(part => part._tag)).toEqual(['Text'])
    expect(assistantContent(message)).toBe('Hello')
  })

  it('does not mutate frozen input arrays or events', () => {
    const call = ToolCall.make({ id: 'call_1', name: 'lookup', params: { q: 'weather' } })
    const text = Object.freeze(LLMTextDelta.make({ text: 'Frozen.' }))
    const tool = Object.freeze(LLMToolCall.make({ call }))
    const events = Object.freeze([text, tool])
    const before = JSON.stringify(events)

    const message = accumulateAssistantMessage(events)

    expect(JSON.stringify(events)).toBe(before)
    expect(Object.isFrozen(events)).toBe(true)
    expect(assistantContent(message)).toBe('Frozen.')
    expect(assistantHostToolCalls(message)).toEqual([call])
  })

  it('skips sparse holes the same way Array.prototype.reduce does', () => {
    const events = [LLMTextDelta.make({ text: 'A' })]
    events[2] = LLMTextDelta.make({ text: 'B' })

    const message = accumulateAssistantMessage(events)

    expect(assistantContent(message)).toBe('AB')
    expect(message.parts).toHaveLength(1)
  })

  it('allocates a distinct public parts array on repeated calls', () => {
    const events = [LLMTextDelta.make({ text: 'One' })]
    const first = accumulateAssistantMessage(events)
    const second = accumulateAssistantMessage(events)

    expect(second.parts).not.toBe(first.parts)
    expect(second.parts[0]).not.toBe(first.parts[0])
    expect(assistantContent(second)).toBe('One')
  })

  it('keeps collectText, collectReasoning, and collectToolCalls', () => {
    const call = ToolCall.make({ id: 'call_1', name: 'lookup', params: { q: 'weather' } })

    const events = [
      LLMTextDelta.make({ text: 'Hi' }),
      LLMReasoningDelta.make({ text: 'why' }),
      LLMToolCall.make({ call })
    ]

    expect(collectText(events)).toBe('Hi')
    expect(collectReasoning(events)).toBe('why')
    expect(collectToolCalls(events)).toEqual([call])
  })
})

const instrumentTextDelta = (event: LLMTextDelta, receipts: string[]): LLMTextDelta => {
  const tag = event._tag
  const text = event.text

  Object.defineProperty(event, '_tag', {
    configurable: true,
    enumerable: true,
    get: () => {
      receipts.push('tag')

      return tag
    }
  })
  Object.defineProperty(event, 'text', {
    configurable: true,
    enumerable: true,
    get: () => {
      receipts.push('text')

      return text
    }
  })

  return event
}

class SliceRecordingParts extends Array<AssistantTextPart> {
  readonly receipts: string[] = []

  override slice(...args: Parameters<Array<AssistantTextPart>['slice']>): AssistantTextPart[] {
    this.receipts.push(`slice(${args.join(',')})`)

    return super.slice(...args)
  }
}

class IdentitySliceParts extends Array<AssistantTextPart> {
  override slice(): this {
    return this
  }
}

describe('applyAssistantLlmEvent', () => {
  it('reads the tag once, then payload, then slice(0, -1) when coalescing text', () => {
    const parts = new SliceRecordingParts()
    const receipts = parts.receipts
    parts.push(AssistantTextPart.make({ content: 'A' }))
    const event = instrumentTextDelta(LLMTextDelta.make({ text: 'B' }), receipts)

    const next = applyAssistantLlmEvent(parts, event)
    const coalesced = next[0]

    expect(receipts.filter(entry => entry === 'tag')).toHaveLength(1)
    expect(receipts).toEqual(['tag', 'text', 'slice(0,-1)'])
    expect(next).not.toBe(parts)
    expect(next).toHaveLength(1)

    if (coalesced === undefined || !Predicate.isTagged(coalesced, 'Text')) {
      throw new Error('expected coalesced text part')
    }

    expect(coalesced.content).toEqual('AB')
  })

  it('does not mutate a frozen parts array and coalesces onto a new array', () => {
    const parts = Object.freeze([AssistantTextPart.make({ content: 'A' })])
    const before = JSON.stringify(parts)

    const next = applyAssistantLlmEvent(parts, LLMTextDelta.make({ text: 'B' }))
    const coalesced = next[0]

    expect(JSON.stringify(parts)).toBe(before)
    expect(Object.isFrozen(parts)).toBe(true)
    expect(next).not.toBe(parts)
    expect(next).toHaveLength(1)

    if (coalesced === undefined || !Predicate.isTagged(coalesced, 'Text')) {
      throw new Error('expected coalesced text part')
    }

    expect(coalesced.content).toEqual('AB')
  })

  it('returns the original parts identity for no-op Done events', () => {
    const parts = [AssistantTextPart.make({ content: 'A' })]

    expect(applyAssistantLlmEvent(parts, LLMDone.make({ stopReason: 'stop' }))).toBe(parts)
  })

  it('does not mutate an array whose slice returns this', () => {
    const original = AssistantTextPart.make({ content: 'A' })
    const parts = new IdentitySliceParts()
    parts.push(original)
    const before = JSON.stringify(parts)

    applyAssistantLlmEvent(parts, LLMTextDelta.make({ text: 'B' }))

    expect(JSON.stringify(parts)).toBe(before)
    expect(parts[0]).toBe(original)
    expect(parts).toHaveLength(1)
    expect(original.content).toBe('A')
  })
})
