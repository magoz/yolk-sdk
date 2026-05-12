import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentContentCapabilities,
  AgentEnd,
  AgentError,
  AgentEvent,
  AgentMessage,
  AgentModelCapabilities,
  AgentReasoningEffort,
  AgentRetry,
  AgentStart,
  AgentUsage,
  AssistantAgentMessage,
  AssistantMessageEvent,
  AssistantReasoningPart,
  AssistantTextPart,
  AudioPart,
  CompactionEnd,
  CompactionStart,
  Content,
  ContentPart,
  ImagePart,
  LLMReasoningDelta,
  LLMStreamEnd,
  LLMStreamStart,
  LLMTextDelta,
  HostToolCallPart,
  TextPart,
  ToolCall,
  ToolDef,
  ToolExecutionCompleted,
  ToolExecutionStarted,
  ToolInputEnd,
  ToolResult,
  ToolResultMessage,
  TurnEnd,
  TurnStart,
  UsageUpdate,
  UserMessage,
  addAgentUsage,
  textImageModelCapabilities,
  textOnlyModelCapabilities,
  zeroAgentUsage,
  type AgentEvent as AgentEventType,
  type AgentMessage as AgentMessageType
} from '../src'

const encodeJson = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)
const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)
const decodeAgentEvent = Schema.decodeUnknownEffect(AgentEvent)
const decodeAgentMessage = Schema.decodeUnknownEffect(AgentMessage)

const roundTripEvent = (event: AgentEventType) =>
  Effect.gen(function* () {
    const json = yield* encodeJson(event)
    const value = yield* decodeJson(json)

    return yield* decodeAgentEvent(value)
  })

const roundTripMessage = (message: AgentMessageType) =>
  Effect.gen(function* () {
    const json = yield* encodeJson(message)
    const value = yield* decodeJson(json)

    return yield* decodeAgentMessage(value)
  })

describe('protocol wire schemas', () => {
  it.effect('round-trips agent message variants through JSON wire values', () =>
    Effect.gen(function* () {
      const call = ToolCall.make({ id: 'call_1', name: 'web_fetch', params: { url: 'https://e.com' } })
      const messages: ReadonlyArray<AgentMessageType> = [
        UserMessage.make({
          content: [
            TextPart.make({ text: 'describe' }),
            ImagePart.make({ data: 'abc', mimeType: 'image/png' }),
            AudioPart.make({ data: 'def', format: 'wav' })
          ]
        }),
        AssistantAgentMessage.make({
          parts: [
            AssistantReasoningPart.make({ text: 'summary' }),
            AssistantTextPart.make({ content: 'ok' }),
            HostToolCallPart.make({ call })
          ]
        }),
        ToolResultMessage.make({ toolCallId: call.id, content: 'result' })
      ]

      const decoded = yield* Effect.forEach(messages, roundTripMessage)

      expect(decoded).toEqual(messages)
    })
  )

  it.effect('round-trips all agent event variants through JSON wire values', () =>
    Effect.gen(function* () {
      const call = ToolCall.make({ id: 'call_1', name: 'web_fetch', params: { url: 'https://e.com' } })
      const result = ToolResult.make({
        toolCallId: call.id,
        content: 'Example Domain',
        structuredContent: { title: 'Example Domain' }
      })
      const assistant = AssistantAgentMessage.make({
        parts: [AssistantTextPart.make({ content: 'done' }), HostToolCallPart.make({ call })]
      })
      const events: ReadonlyArray<AgentEventType> = [
        AgentStart.make({}),
        AgentError.make({ code: 'provider_error', message: 'slow down', retryable: true }),
        AgentEnd.make({ messages: [assistant], turns: 1, usage: zeroAgentUsage }),
        UsageUpdate.make({ usage: zeroAgentUsage }),
        AgentRetry.make({ attempt: 1, reason: 'rate_limit', delayMs: 250, message: 'retrying' }),
        CompactionStart.make({ strategy: 'summarize' }),
        CompactionEnd.make({ strategy: 'summarize', beforeTokens: 100, afterTokens: 20 }),
        TurnStart.make({ turn: 1 }),
        TurnEnd.make({ turn: 1, reason: 'tool_use' }),
        LLMStreamStart.make({ turn: 1 }),
        LLMTextDelta.make({ text: 'hello' }),
        LLMReasoningDelta.make({ text: 'thinking' }),
        ToolInputEnd.make({ call }),
        LLMStreamEnd.make({ turn: 1 }),
        AssistantMessageEvent.make({ message: assistant }),
        ToolExecutionStarted.make({ call }),
        ToolExecutionCompleted.make({ call, result })
      ]

      const decoded = yield* Effect.forEach(events, roundTripEvent)

      expect(decoded).toEqual(events)
    })
  )

  it.effect('round-trips exported tool, content, capability, reasoning, and usage schemas', () =>
    Effect.gen(function* () {
      const call = ToolCall.make({ id: 'call_1', name: 'web_fetch', params: { url: 'https://e.com' } })
      const def = ToolDef.make({ name: 'web_fetch', description: 'Fetch URL', parameters: { type: 'object' } })
      const result = ToolResult.make({
        toolCallId: call.id,
        content: 'ok',
        structuredContent: { ok: true }
      })
      const content = [TextPart.make({ text: 'hi' }), AudioPart.make({ data: 'abc', format: 'mp3' })]
      const capabilities = AgentModelCapabilities.make({
        input: AgentContentCapabilities.make({ text: true, image: true, audio: false }),
        tools: true,
        reasoning: true
      })
      const usage = addAgentUsage(
        AgentUsage.make({
          input: { total: 10, uncached: 4, cacheRead: 3, cacheWrite: 3 },
          output: { total: 8, text: 5, reasoning: 3 }
        }),
        zeroAgentUsage
      )

      expect(yield* Schema.decodeUnknownEffect(ToolCall)(call)).toEqual(call)
      expect(yield* Schema.decodeUnknownEffect(ToolDef)(def)).toEqual(def)
      expect(yield* Schema.decodeUnknownEffect(ToolResult)(result)).toEqual(result)
      expect(yield* Schema.decodeUnknownEffect(ContentPart)(content[0])).toEqual(content[0])
      expect(yield* Schema.decodeUnknownEffect(Content)(content)).toEqual(content)
      expect(yield* Schema.decodeUnknownEffect(AgentModelCapabilities)(capabilities)).toEqual(capabilities)
      expect(yield* Schema.decodeUnknownEffect(AgentReasoningEffort)('xhigh')).toBe('xhigh')
      expect(yield* Schema.decodeUnknownEffect(AgentUsage)(usage)).toEqual(usage)
      expect(textOnlyModelCapabilities.input.image).toBe(false)
      expect(textImageModelCapabilities.input.image).toBe(true)
    })
  )

  it.effect('rejects invalid wire payloads at protocol boundaries', () =>
    Effect.gen(function* () {
      const invalidEvent = yield* decodeAgentEvent({ _tag: 'Nope' }).pipe(Effect.result)
      const emptyToolName = yield* Schema.decodeUnknownEffect(ToolCall)({
        id: 'call_1',
        name: '   ',
        params: {}
      }).pipe(Effect.result)
      const invalidAudio = yield* Schema.decodeUnknownEffect(ContentPart)({
        _tag: 'Audio',
        data: 'abc',
        format: 'flac'
      }).pipe(Effect.result)
      const invalidUsage = yield* Schema.decodeUnknownEffect(AgentUsage)({
        input: { total: '10' },
        output: { total: 0 }
      }).pipe(Effect.result)
      const invalidReasoning = yield* Schema.decodeUnknownEffect(AgentReasoningEffort)('extreme').pipe(
        Effect.result
      )

      expect(invalidEvent._tag).toBe('Failure')
      expect(emptyToolName._tag).toBe('Failure')
      expect(invalidAudio._tag).toBe('Failure')
      expect(invalidUsage._tag).toBe('Failure')
      expect(invalidReasoning._tag).toBe('Failure')
    })
  )
})
