import { Predicate } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  BackgroundToolAccepted,
  HostToolCallPart,
  ToolCall,
  ToolResult,
  ToolResultMessage,
  UserMessage,
  repairDanglingHostToolCalls,
  toolResultMessageFromResult
} from '@yolk-sdk/agent/protocol'

describe('toolResultMessageFromResult', () => {
  it('preserves all result fields and only explicitly supplied message envelope fields', () => {
    const result = ToolResult.make({
      toolCallId: 'work',
      content: 'accepted, not completed',
      isError: false,
      structuredContent: { status: 'accepted' },
      acceptance: BackgroundToolAccepted.make({ version: 1, executionId: 'owner:work' })
    })

    const envelope = {
      createdAtMs: 42,
      author: { displayName: 'Host' },
      annotations: { source: 'test' }
    }

    const message = toolResultMessageFromResult(result, envelope)
    expect(Predicate.isTagged(message, 'ToolResult')).toBe(true)
    expect(message).toMatchObject({ ...result, ...envelope })
    expect(message.content).toBe(result.content)
    expect(message.structuredContent).toBe(result.structuredContent)
    expect(message.acceptance).toBe(result.acceptance)
    expect(toolResultMessageFromResult(result).createdAtMs).toBeUndefined()
    expect(toolResultMessageFromResult(result).author).toBeUndefined()
    expect(toolResultMessageFromResult(result).annotations).toBeUndefined()
    expect(
      toolResultMessageFromResult(ToolResult.make({ toolCallId: 'plain', content: 'done' }))
    ).toMatchObject(ToolResultMessage.make({ toolCallId: 'plain', content: 'done' }))
  })

  it('omits repaired structuredContent unless the host supplies it', () => {
    const messages = [
      AssistantAgentMessage.make({
        parts: [
          HostToolCallPart.make({
            call: ToolCall.make({ id: 'call_1', name: 'lookup', params: {} })
          })
        ]
      }),
      UserMessage.make({ content: 'next' })
    ]

    const omitted = repairDanglingHostToolCalls(messages)[1]

    expect(omitted).toBeInstanceOf(ToolResultMessage)
    expect(Object.keys(omitted ?? {})).toEqual(['toolCallId', 'content', 'isError', '_tag'])
    expect(JSON.stringify(omitted)).toBe(
      '{"toolCallId":"call_1","content":"Tool lookup did not return a result before the transcript continued.","isError":true,"_tag":"ToolResult"}'
    )

    const present = repairDanglingHostToolCalls(messages, {
      structuredContent: () => ({ repaired: true })
    })[1]

    expect(Object.keys(present ?? {})).toEqual([
      'toolCallId',
      'content',
      'isError',
      'structuredContent',
      '_tag'
    ])
    expect(JSON.stringify(present)).toBe(
      '{"toolCallId":"call_1","content":"Tool lookup did not return a result before the transcript continued.","isError":true,"structuredContent":{"repaired":true},"_tag":"ToolResult"}'
    )
  })
})
