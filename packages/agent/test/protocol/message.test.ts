import { Predicate } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  HostToolCallPart,
  ToolCall,
  ToolResultMessage,
  UserMessage,
  danglingHostToolCalls,
  repairDanglingHostToolCalls,
  validateNoDanglingHostToolCalls
} from '../../src/protocol'
import { TranscriptInvariantValidation } from '../../src/protocol/message.ts'

const searchCall = ToolCall.make({ id: 'call_search', name: 'search', params: { query: 'yolk' } })

const fetchCall = ToolCall.make({
  id: 'call_fetch',
  name: 'fetch',
  params: { url: 'https://yolk.ai' }
})

const assistantWithToolCalls = AssistantAgentMessage.make({
  parts: [HostToolCallPart.make({ call: searchCall }), HostToolCallPart.make({ call: fetchCall })]
})

describe('message transcript helpers', () => {
  it('detects host tool calls that are not followed by tool results', () => {
    const dangling = danglingHostToolCalls([
      assistantWithToolCalls,
      ToolResultMessage.make({ toolCallId: searchCall.id, content: 'ok' }),
      UserMessage.make({ content: 'continue' })
    ])

    expect(dangling).toEqual([{ call: fetchCall, assistantMessageIndex: 0, beforeMessageIndex: 2 }])
    const danglingValidation = validateNoDanglingHostToolCalls([assistantWithToolCalls])
    expect(Predicate.isTagged(danglingValidation, 'DanglingHostToolCalls')).toBe(true)
    expect(danglingValidation).toMatchObject({
      calls: [
        { call: searchCall, assistantMessageIndex: 0 },
        { call: fetchCall, assistantMessageIndex: 0 }
      ]
    })
  })

  it('repairs dangling host tool calls with error tool result messages', () => {
    const repaired = repairDanglingHostToolCalls([
      assistantWithToolCalls,
      ToolResultMessage.make({ toolCallId: searchCall.id, content: 'ok' }),
      UserMessage.make({ content: 'continue' })
    ])

    const repairedResult = repaired[2]

    expect(repaired.map(message => message._tag)).toEqual([
      'Assistant',
      'ToolResult',
      'ToolResult',
      'User'
    ])

    const expectedRepairedResultFields = {
      toolCallId: fetchCall.id,
      isError: true,
      content: 'Tool fetch did not return a result before the transcript continued.'
    }

    expect(repairedResult._tag).toBe('ToolResult')
    expect(repairedResult).toMatchObject(expectedRepairedResultFields)
    expect(validateNoDanglingHostToolCalls(repaired)).toEqual(TranscriptInvariantValidation.Valid())
  })

  it('uses custom repair content and structured content', () => {
    const repaired = repairDanglingHostToolCalls([assistantWithToolCalls], {
      content: call => `failed: ${call.name}`,
      structuredContent: call => ({ type: 'missing_tool_result', tool: call.name })
    })

    expect(repaired.slice(1)).toMatchObject([
      ToolResultMessage.make({
        toolCallId: searchCall.id,
        content: 'failed: search',
        isError: true,
        structuredContent: { type: 'missing_tool_result', tool: 'search' }
      }),
      ToolResultMessage.make({
        toolCallId: fetchCall.id,
        content: 'failed: fetch',
        isError: true,
        structuredContent: { type: 'missing_tool_result', tool: 'fetch' }
      })
    ])
  })

  it('omits beforeMessageIndex on trailing dangling calls and preserves JSON key order when present', () => {
    const trailing = danglingHostToolCalls([assistantWithToolCalls])

    const beforeUser = danglingHostToolCalls([
      assistantWithToolCalls,
      UserMessage.make({ content: 'continue' })
    ])

    expect(trailing).toHaveLength(2)
    const trailingFirst = trailing[0]

    if (trailingFirst === undefined) {
      expect.fail('Expected trailing dangling host tool call')
    }

    expect(Object.keys(trailingFirst)).toEqual(['call', 'assistantMessageIndex'])
    expect(Object.hasOwn(trailingFirst, 'beforeMessageIndex')).toBe(false)
    expect(JSON.stringify(trailingFirst)).toBe(
      JSON.stringify({ call: searchCall, assistantMessageIndex: 0 })
    )

    const beforeFirst = beforeUser[0]

    if (beforeFirst === undefined) {
      expect.fail('Expected dangling host tool call before a later message')
    }

    expect(Object.keys(beforeFirst)).toEqual([
      'call',
      'assistantMessageIndex',
      'beforeMessageIndex'
    ])
    expect(beforeFirst.beforeMessageIndex).toBe(1)
  })
})
