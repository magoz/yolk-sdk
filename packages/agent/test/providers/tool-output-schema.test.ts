import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  emptyNestedToolCallRecorder,
  nestedToolCallResultFields,
  recordNestedToolCall,
  ToolResult,
  toolResultMessageFromResult,
  UserMessage,
  AssistantAgentMessage,
  HostToolCallPart,
  ToolCall
} from '@yolk-sdk/agent/protocol'
import { makeTool } from '@yolk-sdk/agent/tools'
import { toAnthropicClaudeRequestBody } from '../../src/providers/anthropic/claude-provider.ts'
import { toOpenAiCodexRequestBody } from '../../src/providers/openai/codex-provider.ts'
import { toOpenAiRequestBody } from '../../src/providers/openai/provider.ts'

const lookup = makeTool({
  name: 'lookup',
  description: 'Look things up.',
  parameters: Schema.Struct({ query: Schema.String }),
  output: Schema.Struct({ hits: Schema.Array(Schema.String) }),
  access: 'read',
  callableBy: 'all',
  execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
})

const call = ToolCall.make({ id: 'call_1', name: 'lookup', params: { query: 'q' } })

const result = ToolResult.make({
  toolCallId: 'call_1',
  content: 'visible result',
  ...nestedToolCallResultFields(
    recordNestedToolCall(emptyNestedToolCallRecorder, {
      id: 'call_1/1',
      name: 'inner',
      args: { marker: 'nested-only-marker' },
      status: 'error',
      error: 'nested-error-marker'
    })
  )
})

const request = {
  model: 'model',
  systemPrompt: 'Use tools.',
  messages: [
    UserMessage.make({ content: 'hello' }),
    AssistantAgentMessage.make({ parts: [HostToolCallPart.make({ call })] }),
    toolResultMessageFromResult(result)
  ],
  tools: [lookup.def]
}

const assertNoCodeModeFields = (body: unknown) => {
  const wire = JSON.stringify(body)

  // Claude compatibility rewrites tool names; the description survives every adapter.
  expect(wire).toContain('Look things up.')
  expect(wire).toContain('visible result')
  expect(wire).not.toContain('outputSchema')
  expect(wire).not.toContain('callableBy')
  expect(wire).not.toContain('hits')
  expect(wire).not.toContain('nested-only-marker')
  expect(wire).not.toContain('nested-error-marker')
}

describe('provider lowering ignores code mode tool contract fields', () => {
  it.effect(
    'OpenAI-compatible chat, Codex, and Claude bodies omit output schemas and records',
    () =>
      Effect.gen(function* () {
        expect(lookup.def.outputSchema).toBeDefined()

        assertNoCodeModeFields(yield* toOpenAiRequestBody(request, { maxCompletionTokens: 64 }))
        assertNoCodeModeFields(yield* toOpenAiCodexRequestBody(request, {}))
        assertNoCodeModeFields(yield* toAnthropicClaudeRequestBody(request, { maxTokens: 64 }))
      })
  )
})
