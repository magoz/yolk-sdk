import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import { ToolResult, toolJsonSchemaOmittedNullComment, UserMessage } from '@yolk-sdk/agent/protocol'
import { makeTool } from '@yolk-sdk/agent/tools'
import { toAnthropicRequestBody } from '../../src/providers/anthropic-provider-internal.ts'
import { toAnthropicClaudeRequestBody } from '../../src/providers/anthropic/claude-provider.ts'
import { toOpenAiCodexRequestBody } from '../../src/providers/openai/codex-provider.ts'
import { toOpenAiRequestBody } from '../../src/providers/openai/provider.ts'
import {
  openAiRealtimeToolParameters,
  toOpenAiRealtimeTool
} from '../../src/providers/openai/realtime/session-config.ts'
import { toXAiGrokRequestBody } from '../../src/providers/xai/grok-provider.ts'
import { withoutToolJsonSchemaOmittedNullMarker } from '../../src/protocol/tool-json-schema-marker.ts'
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

const expectNoMarker = (body: unknown, description = 'Search.') => {
  const wire = JSON.stringify(body)

  expect(wire).toContain(description)
  expect(wire).not.toContain(toolJsonSchemaOmittedNullComment)

  // `Params` has no property named `$comment`, so no `$comment` key may remain.
  if (description === 'Search.') {
    expect(wire).not.toContain('$comment')
  }
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

  it('strips the marker from host-built OpenAI Realtime parameters', () => {
    const rootUnion = makeTool({
      name: 'schedule',
      description: 'Schedule.',
      parameters: Schema.Union([
        Schema.Struct({ kind: Schema.Literal('a'), note: Schema.optional(Schema.String) }),
        Schema.Struct({ kind: Schema.Literal('b') })
      ]),
      access: 'read',
      execute: ({ call }) => Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
    })

    for (const parameters of [search.def.parameters, rootUnion.def.parameters]) {
      expect(JSON.stringify(parameters)).toContain(toolJsonSchemaOmittedNullComment)
      expect(JSON.stringify(openAiRealtimeToolParameters(parameters))).not.toContain('$comment')
    }
  })

  it.effect('treats author-chosen names as names, never as keywords', () =>
    Effect.gen(function* () {
      const marked = { type: 'null', $comment: toolJsonSchemaOmittedNullComment }
      const optionalNote = { anyOf: [{ type: 'string' }, marked] }

      // Every map whose keys the author names, with keyword-looking names.
      const reserved = Schema.Struct({
        enum: Schema.optional(Schema.String),
        default: Schema.optional(Schema.Number),
        const: Schema.optional(Schema.Boolean),
        examples: Schema.optional(Schema.String),
        $comment: Schema.optional(Schema.String)
      })

      const reservedTool = makeTool({
        name: 'reserved',
        description: 'Reserved names.',
        parameters: reserved,
        access: 'read',
        execute: ({ call }) =>
          Effect.succeed(ToolResult.make({ toolCallId: call.id, content: 'ok' }))
      })

      const markers = JSON.stringify(reservedTool.def.parameters).split(
        toolJsonSchemaOmittedNullComment
      )

      // Lowering marks all five properties.
      expect(markers).toHaveLength(6)

      const raw = {
        type: 'object',
        properties: { enum: optionalNote },
        patternProperties: { '^default$': optionalNote },
        dependencies: {
          enum: { properties: { const: optionalNote } },
          default: ['enum', 'examples']
        },
        dependentSchemas: { examples: { properties: { enum: optionalNote } } },
        $defs: { const: optionalNote }
      }

      const stripped = withoutToolJsonSchemaOmittedNullMarker(raw)
      expect(JSON.stringify(stripped)).not.toContain('$comment')
      // Property-dependency arrays are data and stay as they are.
      expect(stripped).toMatchObject({ dependencies: { default: ['enum', 'examples'] } })

      const rawTool = { ...reservedTool.def, name: 'raw', parameters: raw }

      for (const tool of [reservedTool.def, rawTool]) {
        const toolRequest = { ...request, tools: [tool] }
        const description = 'Reserved names.'

        expectNoMarker(
          yield* toOpenAiRequestBody(toolRequest, { maxCompletionTokens: 64 }),
          description
        )
        expectNoMarker(yield* toOpenAiCodexRequestBody(toolRequest, {}), description)
        expectNoMarker(
          yield* toAnthropicClaudeRequestBody(toolRequest, { maxTokens: 64 }),
          description
        )
        expectNoMarker(
          yield* toAnthropicRequestBody(toolRequest, { maxTokens: 64, claudeCompatibility: false }),
          description
        )
      }
    })
  )
})
