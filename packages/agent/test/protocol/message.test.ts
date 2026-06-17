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

const searchCall = ToolCall.make({ id: 'call_search', name: 'search', params: { query: 'yolk' } })
const fetchCall = ToolCall.make({ id: 'call_fetch', name: 'fetch', params: { url: 'https://yolk.ai' } })

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

    expect(dangling).toEqual([
      { call: fetchCall, assistantMessageIndex: 0, beforeMessageIndex: 2 }
    ])
    expect(validateNoDanglingHostToolCalls([assistantWithToolCalls])).toMatchObject({
      _tag: 'DanglingHostToolCalls',
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
    expect(repairedResult).toMatchObject({
      _tag: 'ToolResult',
      toolCallId: fetchCall.id,
      isError: true,
      content: 'Tool fetch did not return a result before the transcript continued.'
    })
    expect(validateNoDanglingHostToolCalls(repaired)).toEqual({ _tag: 'Valid' })
  })

  it('uses custom repair content and structured content', () => {
    const repaired = repairDanglingHostToolCalls([assistantWithToolCalls], {
      content: call => `failed: ${call.name}`,
      structuredContent: call => ({ type: 'missing_tool_result', tool: call.name })
    })

    expect(repaired.slice(1)).toMatchObject([
      {
        _tag: 'ToolResult',
        toolCallId: searchCall.id,
        content: 'failed: search',
        isError: true,
        structuredContent: { type: 'missing_tool_result', tool: 'search' }
      },
      {
        _tag: 'ToolResult',
        toolCallId: fetchCall.id,
        content: 'failed: fetch',
        isError: true,
        structuredContent: { type: 'missing_tool_result', tool: 'fetch' }
      }
    ])
  })
})
