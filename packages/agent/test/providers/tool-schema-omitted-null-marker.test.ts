import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { ToolResult, toolJsonSchemaOmittedNullComment, UserMessage } from '@yolk-sdk/agent/protocol'
import { makeTool } from '@yolk-sdk/agent/tools'
import { toAnthropicRequestBody } from '../../src/providers/anthropic-provider-internal.ts'
import { toAnthropicClaudeRequestBody } from '../../src/providers/anthropic/claude-provider.ts'
import { toOpenAiCodexRequestBody } from '../../src/providers/openai/codex-provider.ts'
import { toOpenAiRequestBody } from '../../src/providers/openai/provider.ts'
import { toOpenAiRealtimeTool } from '../../src/providers/openai/realtime/session-config.ts'
import { toXAiGrokRequestBody } from '../../src/providers/xai/grok-provider.ts'
import { toolJsonSchemaFromDocument } from '../../src/tools/registry.ts'

const Shared = Schema.Struct({
  id: Schema.String,
  note: Schema.optional(Schema.String)
}).annotate({ identifier: 'Shared' })

const Params = Schema.Struct({
  query: Schema.String,
  limit: Schema.optional(Schema.Number),
  shared: Schema.optional(Shared),
  clear: Schema.optionalKey(Schema.NullOr(Schema.String))
})

const search = makeTool({
  name: 'search',
  description: 'Search.',
  parameters: Params,
  access: 'read',
  execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
})

/** `ToolDef.parameters` as lowered before the omitted-null marker existed. */
const previousParameters = toolJsonSchemaFromDocument(
  Params,
  Schema.toJsonSchemaDocument(Params, { onExcessProperty: 'error' })
)

const request = {
  model: 'model',
  systemPrompt: 'Use tools.',
  messages: [UserMessage.make({ content: 'hello' })],
  tools: [search.def]
}

const expectNoMarker = (body: unknown) => {
  const wire = JSON.stringify(body)

  expect(wire).toContain('Search.')
  expect(wire).not.toContain(toolJsonSchemaOmittedNullComment)
  expect(wire).not.toContain('$comment')
}

describe('omitted-null marker at provider boundaries', () => {
  it('stays in ToolDef.parameters, the single source of truth', () => {
    expect(JSON.stringify(search.def.parameters)).toContain(toolJsonSchemaOmittedNullComment)
  })

  it.effect('never reaches any provider request body', () =>
    Effect.gen(function* () {
      expectNoMarker(yield* toOpenAiRequestBody(request, { maxCompletionTokens: 64 }))
      expectNoMarker(yield* toOpenAiCodexRequestBody(request, {}))
      expectNoMarker(yield* toXAiGrokRequestBody(request, { maxOutputTokens: 64 }))
      expectNoMarker(yield* toAnthropicClaudeRequestBody(request, { maxTokens: 64 }))
      expectNoMarker(
        yield* toAnthropicRequestBody(request, { maxTokens: 64, claudeCompatibility: false })
      )
      expectNoMarker(toOpenAiRealtimeTool(search.def))
    })
  )

  it.effect('sends unchanged schemas where the marker is not used', () =>
    Effect.gen(function* () {
      const previous = JSON.stringify(previousParameters)

      const openAi = yield* toOpenAiRequestBody(request, { maxCompletionTokens: 64 })
      const codex = yield* toOpenAiCodexRequestBody(request, {})

      const anthropic = yield* toAnthropicRequestBody(request, {
        maxTokens: 64,
        claudeCompatibility: false
      })

      expect(JSON.stringify(openAi.tools?.[0]?.function.parameters)).toBe(previous)
      expect(JSON.stringify(codex.tools?.[0]?.parameters)).toBe(previous)
      expect(JSON.stringify(anthropic.tools?.[0]?.input_schema)).toBe(previous)
    })
  )
})
