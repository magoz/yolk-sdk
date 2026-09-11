import { describe, expect, it } from '@effect/vitest'
import {
  BackgroundToolAccepted,
  ToolResult,
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
    expect(message).toMatchObject({ _tag: 'ToolResult', ...result, ...envelope })
    expect(message.content).toBe(result.content)
    expect(message.structuredContent).toBe(result.structuredContent)
    expect(message.acceptance).toBe(result.acceptance)
    expect(toolResultMessageFromResult(result).createdAtMs).toBeUndefined()
    expect(toolResultMessageFromResult(result).author).toBeUndefined()
    expect(toolResultMessageFromResult(result).annotations).toBeUndefined()
    expect(
      toolResultMessageFromResult(ToolResult.make({ toolCallId: 'plain', content: 'done' }))
    ).toMatchObject({ _tag: 'ToolResult', toolCallId: 'plain', content: 'done' })
  })
})
