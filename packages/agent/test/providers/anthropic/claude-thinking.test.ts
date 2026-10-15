import { Effect, Layer, Predicate, Stream } from 'effect'
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/http'
import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  AssistantReasoningPart,
  AssistantTextPart,
  HostToolCallPart,
  ToolCall,
  ToolDef,
  ToolResultMessage,
  UserMessage
} from '@yolk-sdk/agent/protocol'
import { OAuthAccessToken } from '@yolk-sdk/agent/oauth'
import { accumulateAssistantMessage, LLMProvider } from '@yolk-sdk/agent/loop'
import {
  makeAnthropicClaudeProviderLayer,
  toAnthropicClaudeRequestBody,
  type AnthropicClaudeProviderConfig
} from '../../../src/providers/anthropic/claude-provider.ts'
import { toAnthropicRequestBody } from '../../../src/providers/anthropic-provider-internal.ts'

const maxTokens = 123

const token = () =>
  new OAuthAccessToken({
    provider: 'anthropic-claude',
    accessToken: 'token',
    expiresAt: Date.now() + 60_000
  })

const sse = (events: ReadonlyArray<object>) =>
  events.map(event => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join('')

const signature = 'EqQBCgIYAhIM-signature'

const redactedData = 'EmwKAhgBEgy-redacted'

/** Summarized thinking, a redacted block, an empty (omitted) block, text and a tool call. */
const thinkingStream = sse([
  { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'thinking', thinking: '', signature: '' }
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'Check the ' }
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'weather.' }
  },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'redacted_thinking', data: redactedData }
  },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Looking it up.' } },
  { type: 'content_block_stop', index: 2 },
  {
    type: 'content_block_start',
    index: 3,
    content_block: { type: 'thinking', thinking: '', signature: '' }
  },
  { type: 'content_block_delta', index: 3, delta: { type: 'thinking_delta', thinking: '' } },
  {
    type: 'content_block_delta',
    index: 3,
    delta: { type: 'signature_delta', signature: 'omitted-sig' }
  },
  { type: 'content_block_stop', index: 3 },
  {
    type: 'content_block_start',
    index: 4,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'mcp_Weather', input: {} }
  },
  {
    type: 'content_block_delta',
    index: 4,
    delta: { type: 'input_json_delta', partial_json: '{"city":"Paris"}' }
  },
  { type: 'content_block_stop', index: 4 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
  { type: 'message_stop' }
])

type Captured = Array<HttpClientRequest.HttpClientRequest>

const httpClientLayer = (body: string, captured: Captured) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(request =>
      Effect.sync(() => {
        captured.push(request)

        return HttpClientResponse.fromWeb(request, new Response(body, { status: 200 }))
      })
    )
  )

const streamClaude = (
  body: string,
  captured: Captured,
  config: Partial<Pick<AnthropicClaudeProviderConfig, 'thinking'>> = {}
) =>
  Effect.gen(function* () {
    const provider = yield* LLMProvider

    return Array.from(
      yield* provider
        .stream({
          model: 'claude-opus-5-5',
          systemPrompt: '',
          messages: [UserMessage.make({ content: 'Weather in Paris?' })],
          tools: []
        })
        .pipe(Stream.runCollect)
    )
  }).pipe(
    Effect.provide(
      makeAnthropicClaudeProviderLayer({ token: token(), maxTokens, ...config }).pipe(
        Layer.provide(httpClientLayer(body, captured))
      )
    )
  )

const capturedBody = (captured: Captured) => {
  const body = captured[0]?.body

  if (body?._tag !== 'Uint8Array') return expect.fail('Expected a request body')

  return JSON.parse(new TextDecoder().decode(body.body))
}

const weatherTool = ToolDef.make({
  name: 'weather',
  description: 'Weather for a city.',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
})

describe('Anthropic Claude thinking', () => {
  it.effect('requests adaptive thinking with display and prefix mismatch behavior', () =>
    Effect.gen(function* () {
      const request = {
        model: 'claude-opus-5-5',
        systemPrompt: '',
        messages: [UserMessage.make({ content: 'hello' })],
        tools: []
      }

      const withBinding = yield* toAnthropicClaudeRequestBody(request, {
        maxTokens,
        thinking: { display: 'summarized', prefixMismatchBehavior: 'drop_block' }
      })

      const displayOnly = yield* toAnthropicClaudeRequestBody(request, {
        maxTokens,
        thinking: { display: 'summarized' }
      })

      const absent = yield* toAnthropicClaudeRequestBody(request, { maxTokens })

      expect(withBinding.thinking).toEqual({
        type: 'adaptive',
        display: 'summarized',
        block_binding: { prefix_mismatch_behavior: 'drop_block' }
      })
      expect(displayOnly.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
      expect(absent).not.toHaveProperty('thinking')
    })
  )

  it.effect('sends the binding controls beta only with a mismatch behavior', () =>
    Effect.gen(function* () {
      const binding: Captured = []
      const display: Captured = []

      yield* streamClaude(thinkingStream, binding, {
        thinking: { display: 'summarized', prefixMismatchBehavior: 'drop_block' }
      })

      yield* streamClaude(thinkingStream, display, { thinking: { display: 'summarized' } })

      expect(binding[0]?.headers['anthropic-beta']?.split(',')).toContain(
        'thinking-binding-controls-2026-08-01'
      )
      expect(display[0]?.headers['anthropic-beta']).not.toContain('thinking-binding-controls')
      expect(capturedBody(binding).thinking).toEqual({
        type: 'adaptive',
        display: 'summarized',
        block_binding: { prefix_mismatch_behavior: 'drop_block' }
      })
    })
  )

  it.effect('streams thinking text and closes each block with its replay state', () =>
    Effect.gen(function* () {
      const events = yield* streamClaude(thinkingStream, [])

      expect(events.filter(event => !Predicate.isTagged(event, 'Usage'))).toEqual([
        expect.objectContaining({ _tag: 'ReasoningDelta', text: 'Check the ' }),
        expect.objectContaining({ _tag: 'ReasoningDelta', text: 'weather.' }),
        expect.objectContaining({
          _tag: 'ReasoningReplay',
          replay: { _tag: 'Signed', provider: 'anthropic_claude', signature }
        }),
        expect.objectContaining({
          _tag: 'ReasoningReplay',
          replay: { _tag: 'Redacted', provider: 'anthropic_claude', data: redactedData }
        }),
        expect.objectContaining({ _tag: 'TextDelta', text: 'Looking it up.' }),
        // Omitted thinking streams an empty delta: no text, only the signature.
        expect.objectContaining({
          _tag: 'ReasoningReplay',
          replay: { _tag: 'Signed', provider: 'anthropic_claude', signature: 'omitted-sig' }
        }),
        expect.objectContaining({ _tag: 'ToolCall' }),
        expect.objectContaining({ _tag: 'Done', stopReason: 'tool_use' })
      ])
    })
  )

  it.effect('reads thinking signatures and redacted thinking from JSON responses', () =>
    Effect.gen(function* () {
      const events = yield* streamClaude(
        JSON.stringify({
          content: [
            { type: 'thinking', thinking: 'Short.', signature },
            { type: 'redacted_thinking', data: redactedData },
            { type: 'text', text: 'Hi.' }
          ],
          stop_reason: 'end_turn'
        }),
        []
      )

      expect(events.map(event => event._tag)).toEqual([
        'ReasoningDelta',
        'ReasoningReplay',
        'ReasoningReplay',
        'TextDelta',
        'Done'
      ])
    })
  )

  it.effect('replays the streamed assistant turn exactly, in order', () =>
    Effect.gen(function* () {
      const events = yield* streamClaude(thinkingStream, [])
      const assistant = accumulateAssistantMessage(events)

      expect(assistant.parts.map(part => part._tag)).toEqual([
        'Reasoning',
        'Reasoning',
        'Text',
        'Reasoning',
        'HostToolCall'
      ])

      const body = yield* toAnthropicClaudeRequestBody(
        {
          model: 'claude-opus-5-5',
          systemPrompt: '',
          messages: [
            UserMessage.make({ content: 'Weather in Paris?' }),
            assistant,
            ToolResultMessage.make({ toolCallId: 'toolu_1', content: 'Sunny' })
          ],
          tools: [weatherTool]
        },
        { maxTokens }
      )

      expect(body.messages[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Check the weather.', signature },
          { type: 'redacted_thinking', data: redactedData },
          { type: 'text', text: 'Looking it up.' },
          { type: 'thinking', thinking: '', signature: 'omitted-sig' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'mcp_Weather',
            input: { city: 'Paris' }
          }
        ]
      })
    })
  )

  it.effect('never puts a cache marker on a thinking block', () =>
    Effect.gen(function* () {
      const body = yield* toAnthropicClaudeRequestBody(
        {
          model: 'claude-opus-5-5',
          systemPrompt: '',
          messages: [
            UserMessage.make({ content: 'hello' }),
            AssistantAgentMessage.make({
              parts: [
                AssistantTextPart.make({ content: 'Hi.' }),
                AssistantReasoningPart.make({
                  text: '',
                  replay: { _tag: 'Signed', provider: 'anthropic_claude', signature }
                })
              ]
            })
          ],
          tools: []
        },
        { maxTokens }
      )

      expect(body.messages[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hi.' },
          { type: 'thinking', thinking: '', signature }
        ]
      })
    })
  )

  it.effect('keeps the flattened shape without replayable reasoning', () =>
    Effect.gen(function* () {
      const call = ToolCall.make({ id: 'toolu_1', name: 'weather', params: { city: 'Paris' } })

      const body = yield* toAnthropicClaudeRequestBody(
        {
          model: 'claude-opus-5-5',
          systemPrompt: '',
          messages: [
            UserMessage.make({ content: 'Weather?' }),
            AssistantAgentMessage.make({
              parts: [
                AssistantReasoningPart.make({ text: 'Unsigned reasoning.' }),
                HostToolCallPart.make({ call }),
                // Another provider's state is never sent to Claude.
                AssistantReasoningPart.make({
                  text: 'Foreign.',
                  replay: { _tag: 'Signed', provider: 'other', signature }
                }),
                AssistantTextPart.make({ content: 'Checking.' })
              ]
            }),
            ToolResultMessage.make({ toolCallId: 'toolu_1', content: 'Sunny' })
          ],
          tools: [weatherTool]
        },
        { maxTokens }
      )

      expect(body.messages[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'mcp_Weather',
            input: { city: 'Paris' }
          }
        ]
      })
    })
  )

  it.effect('never replays Claude signatures to native Messages backends', () =>
    Effect.gen(function* () {
      const body = yield* toAnthropicRequestBody(
        {
          model: 'go-model',
          systemPrompt: '',
          messages: [
            UserMessage.make({ content: 'hello' }),
            AssistantAgentMessage.make({
              parts: [
                AssistantReasoningPart.make({
                  text: 'Greet.',
                  replay: { _tag: 'Signed', provider: 'anthropic_claude', signature }
                }),
                AssistantTextPart.make({ content: 'Hi.' })
              ]
            }),
            UserMessage.make({ content: 'again' })
          ],
          tools: []
        },
        { maxTokens, claudeCompatibility: false }
      )

      expect(body.messages[1]).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi.' }]
      })
    })
  )

  it.effect('renders message context before replayed blocks', () =>
    Effect.gen(function* () {
      const body = yield* toAnthropicClaudeRequestBody(
        {
          model: 'claude-opus-5-5',
          systemPrompt: '',
          messages: [
            UserMessage.make({ content: 'hello' }),
            AssistantAgentMessage.make({
              createdAtMs: 0,
              parts: [
                AssistantReasoningPart.make({
                  text: 'Greet.',
                  replay: { _tag: 'Signed', provider: 'anthropic_claude', signature }
                }),
                AssistantTextPart.make({ content: 'Hi.' })
              ]
            }),
            UserMessage.make({ content: 'again' })
          ],
          tools: []
        },
        { maxTokens }
      )

      expect(body.messages[1]).toEqual({
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Message metadata:\n- sent_at: 1970-01-01T00:00:00.000Z\n\nMessage:'
          },
          { type: 'thinking', thinking: 'Greet.', signature },
          { type: 'text', text: 'Hi.' }
        ]
      })
    })
  )
})
