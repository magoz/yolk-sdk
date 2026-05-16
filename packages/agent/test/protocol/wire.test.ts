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
  AgentWebSocketClientMessage,
  AgentWebSocketServerMessage,
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
  ProviderToolCallPart,
  ProviderToolResult,
  ProviderToolResultPart,
  SessionSnapshot,
  SubagentCompleted,
  SubagentStarted,
  TextPart,
  ToolApprovalDenied,
  ToolApprovalGranted,
  ToolApprovalRequested,
  ToolCall,
  ToolDef,
  ToolExecutionCompleted,
  ToolExecutionError,
  ToolExecutionStarted,
  ToolInputDelta,
  ToolInputEnd,
  ToolInputStart,
  ToolResult,
  ToolResultMessage,
  TurnEnd,
  TurnStart,
  UsageUpdate,
  UserInput,
  UserMessage,
  addAgentUsage,
  textImageModelCapabilities,
  textOnlyModelCapabilities,
  zeroAgentUsage,
  type AgentEvent as AgentEventType,
  type AgentMessage as AgentMessageType
} from '../../src/protocol'

const encodeJson = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)
const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)
const decodeAgentEvent = Schema.decodeUnknownEffect(AgentEvent)
const decodeAgentMessage = Schema.decodeUnknownEffect(AgentMessage)
const decodeClientMessage = Schema.decodeUnknownEffect(AgentWebSocketClientMessage)
const decodeServerMessage = Schema.decodeUnknownEffect(AgentWebSocketServerMessage)

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
      const call = ToolCall.make({
        id: 'call_1',
        name: 'web_fetch',
        params: { url: 'https://e.com' }
      })
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
            HostToolCallPart.make({ call }),
            ProviderToolCallPart.make({ call }),
            ProviderToolResultPart.make({
              toolCallId: call.id,
              result: ToolResult.make({
                toolCallId: call.id,
                content: 'provider result',
                isError: true
              })
            })
          ]
        }),
        ToolResultMessage.make({ toolCallId: call.id, content: 'result', isError: true })
      ]

      const decoded = yield* Effect.forEach(messages, roundTripMessage)

      expect(decoded).toEqual(messages)
    })
  )

  it.effect('round-trips all agent event variants through JSON wire values', () =>
    Effect.gen(function* () {
      const call = ToolCall.make({
        id: 'call_1',
        name: 'web_fetch',
        params: { url: 'https://e.com' }
      })
      const result = ToolResult.make({
        toolCallId: call.id,
        content: 'Example Domain',
        isError: true,
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
        ToolInputStart.make({ id: call.id, name: call.name }),
        ToolInputDelta.make({ id: call.id, delta: '{"url"' }),
        ToolInputEnd.make({ call }),
        LLMStreamEnd.make({ turn: 1 }),
        AssistantMessageEvent.make({ message: assistant }),
        ToolApprovalRequested.make({ call }),
        ToolApprovalGranted.make({ toolCallId: call.id }),
        ToolApprovalDenied.make({ toolCallId: call.id, reason: 'policy' }),
        ToolExecutionStarted.make({ call }),
        ToolExecutionCompleted.make({ call, result }),
        ToolExecutionError.make({ call, message: 'failed safely', code: 'tool_error' }),
        ProviderToolResult.make({ call, result }),
        SubagentStarted.make({
          parentToolCallId: call.id,
          subagentRunId: 'subagent:call_1',
          subagentType: 'general',
          description: 'inspect bug',
          model: 'gpt-test',
          createdAtMs: 100
        }),
        SubagentCompleted.make({
          parentToolCallId: call.id,
          subagentRunId: 'subagent:call_1',
          subagentType: 'general',
          description: 'inspect bug',
          model: 'gpt-test',
          status: 'completed',
          durationMs: 25,
          summary: 'done',
          createdAtMs: 125
        })
      ]

      const decoded = yield* Effect.forEach(events, roundTripEvent)

      expect(decoded).toEqual(events)
    })
  )

  it.effect('round-trips optional event identity', () =>
    Effect.gen(function* () {
      const event = LLMTextDelta.make({ eventId: 'workflow:1:0', createdAtMs: 123, text: 'hello' })

      expect(yield* roundTripEvent(event)).toEqual(event)
    })
  )

  it.effect('round-trips session websocket envelope variants', () =>
    Effect.gen(function* () {
      const user = UserMessage.make({ content: 'hello' })
      const clientMessages = [
        UserInput.make({ message: user }),
        UserInput.make({
          message: user,
          expectedRevision: 3,
          model: 'gpt-test',
          reasoningEffort: 'medium'
        })
      ]
      const serverMessages = [
        SessionSnapshot.make({ revision: 3, messages: [user] }),
        LLMTextDelta.make({ eventId: 'evt_1', text: 'hi' })
      ]

      const decodedClientMessages = yield* Effect.forEach(clientMessages, message =>
        Effect.gen(function* () {
          const json = yield* encodeJson(message)
          const value = yield* decodeJson(json)

          return yield* decodeClientMessage(value)
        })
      )
      const decodedServerMessages = yield* Effect.forEach(serverMessages, message =>
        Effect.gen(function* () {
          const json = yield* encodeJson(message)
          const value = yield* decodeJson(json)

          return yield* decodeServerMessage(value)
        })
      )

      expect(decodedClientMessages).toEqual(clientMessages)
      expect(decodedServerMessages).toEqual(serverMessages)
    })
  )

  it.effect('round-trips exported tool, content, capability, reasoning, and usage schemas', () =>
    Effect.gen(function* () {
      const call = ToolCall.make({
        id: 'call_1',
        name: 'web_fetch',
        params: { url: 'https://e.com' }
      })
      const def = ToolDef.make({
        name: 'web_fetch',
        description: 'Fetch URL',
        parameters: { type: 'object' }
      })
      const result = ToolResult.make({
        toolCallId: call.id,
        content: 'ok',
        isError: true,
        structuredContent: { ok: true }
      })
      const content = [
        TextPart.make({ text: 'hi' }),
        AudioPart.make({ data: 'abc', format: 'mp3' })
      ]
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
      expect(yield* Schema.decodeUnknownEffect(AgentModelCapabilities)(capabilities)).toEqual(
        capabilities
      )
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
      const invalidReasoning = yield* Schema.decodeUnknownEffect(AgentReasoningEffort)(
        'extreme'
      ).pipe(Effect.result)
      const invalidClientEnvelope = yield* decodeClientMessage({
        _tag: 'UserInput',
        message: { _tag: 'Assistant', parts: [] }
      }).pipe(Effect.result)
      const invalidServerEnvelope = yield* decodeServerMessage({
        _tag: 'SessionSnapshot',
        revision: 1,
        messages: [{ _tag: 'Nope' }]
      }).pipe(Effect.result)
      const invalidNestedToolResult = yield* decodeAgentEvent({
        _tag: 'ToolExecutionCompleted',
        call: { id: 'call_1', name: 'web_fetch', params: {} },
        result: { toolCallId: '   ', content: 'ok' }
      }).pipe(Effect.result)
      const invalidSubagentStatus = yield* decodeAgentEvent({
        _tag: 'SubagentCompleted',
        parentToolCallId: 'call_1',
        subagentRunId: 'subagent_1',
        subagentType: 'general',
        description: 'inspect',
        model: 'gpt-test',
        status: 'cancelled',
        durationMs: 10
      }).pipe(Effect.result)

      expect(invalidEvent._tag).toBe('Failure')
      expect(emptyToolName._tag).toBe('Failure')
      expect(invalidAudio._tag).toBe('Failure')
      expect(invalidUsage._tag).toBe('Failure')
      expect(invalidReasoning._tag).toBe('Failure')
      expect(invalidClientEnvelope._tag).toBe('Failure')
      expect(invalidServerEnvelope._tag).toBe('Failure')
      expect(invalidNestedToolResult._tag).toBe('Failure')
      expect(invalidSubagentStatus._tag).toBe('Failure')
    })
  )
})
