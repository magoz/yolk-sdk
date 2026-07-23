import { Effect, Ref, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  AssistantReasoningPart,
  AssistantTextPart,
  HostToolCallPart,
  ProviderToolCallPart,
  ProviderToolResultPart,
  TextPart,
  ToolCall,
  ToolResult,
  ToolResultMessage,
  UserMessage,
  type AgentMessage
} from '@yolk-sdk/agent/protocol'
import {
  ContextTransformer,
  LLMError,
  LLMTextDelta,
  type LLMEvent,
  type LLMProviderError,
  type LLMRequest
} from '@yolk-sdk/agent/loop'
import {
  compactWindowMessages,
  compactionSummarySourceMessages,
  contextBudgetStatus,
  contextBudgetUsageRatio,
  estimateAgentMessagesTokens,
  estimateAgentMessageTokens,
  formatAgentMessageForCompaction,
  formatAgentMessagesForCompaction,
  makeCompactionCheckpointMessage,
  makeContextOverflowRetryProvider,
  makeContextBudget,
  makePreviewSummaryMessage,
  makeWindowCompactionTransformer,
  planWindowCompaction
} from '../../src/compaction'

const user = (content: string) => UserMessage.make({ content })

const assistant = (content: string) =>
  AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content })] })

const toolCallingAssistant = () =>
  AssistantAgentMessage.make({
    parts: [
      HostToolCallPart.make({ call: ToolCall.make({ id: 'call_1', name: 'lookup', params: {} }) })
    ]
  })

const toolResult = () => ToolResultMessage.make({ toolCallId: 'call_1', content: 'result' })

const contextOverflowError = () =>
  new LLMError({
    cause: 'context_overflow',
    message: 'context overflow',
    retryable: false
  })

type TestProvider = {
  readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMProviderError>
}

const compactionOptions = {
  strategy: 'test-window-v1',
  thresholdTokens: 20,
  tailMessageCount: 2,
  makeSummaryMessage: (messages: ReadonlyArray<AgentMessage>) =>
    makePreviewSummaryMessage(messages, { maxCharacters: 24 })
}

describe('agent compaction', () => {
  it('models context budgets', () => {
    const budget = makeContextBudget({
      contextWindowTokens: 100,
      reservedOutputTokens: 20,
      warningRatio: 0.75,
      compactionRatio: 1
    })

    expect(budget.usableInputTokens).toBe(80)
    expect(budget.warningInputTokens).toBe(60)
    expect(budget.compactionInputTokens).toBe(80)
    expect(contextBudgetUsageRatio(40, budget)).toBe(0.5)
    expect(contextBudgetStatus(0, budget)).toBe('idle')
    expect(contextBudgetStatus(1, budget)).toBe('normal')
    expect(contextBudgetStatus(60, budget)).toBe('warning')
    expect(contextBudgetStatus(80, budget)).toBe('compact')
  })

  it('estimates text, media, and tool-call messages', () => {
    expect(estimateAgentMessageTokens(user('abcd'))).toBe(7)
    expect(
      estimateAgentMessageTokens(UserMessage.make({ content: [TextPart.make({ text: 'abcd' })] }))
    ).toBe(7)
    expect(estimateAgentMessageTokens(toolCallingAssistant())).toBeGreaterThan(6)
    expect(
      estimateAgentMessageTokens(user('encoded'), {
        countTextTokens: text => text.length * 2
      })
    ).toBe(20)
  })

  it('plans window compaction only above threshold', () => {
    const messages = [user('hello'), assistant('hi'), user('small')]
    const skipped = planWindowCompaction(messages, { thresholdTokens: 10_000 })
    const planned = planWindowCompaction(messages, { thresholdTokens: 1, tailMessageCount: 1 })

    expect(skipped._tag).toBe('Skip')
    expect(planned._tag).toBe('Compact')
  })

  it('compacts old messages and emits lifecycle events', () => {
    const recent = [user('recent question'), assistant('recent answer')]
    const messages = [
      user('old context '.repeat(20)),
      assistant('old answer '.repeat(20)),
      ...recent
    ]
    const result = compactWindowMessages(messages, compactionOptions)

    if (result._tag !== 'Compacted') {
      throw new Error(`Expected compaction, got ${result._tag}`)
    }

    expect(result.events.map(event => event._tag)).toEqual(['CompactionStart', 'CompactionEnd'])
    expect(result.messages.slice(-recent.length)).toEqual(recent)
    const summaryMessage = result.messages[0]
    if (summaryMessage?._tag !== 'User') {
      throw new Error('Expected summary user message')
    }
    expect(summaryMessage.content).toContain('Earlier conversation compacted')
    expect(result.afterTokens).toBeLessThan(result.beforeTokens)
    expect(estimateAgentMessagesTokens(result.messages)).toBe(result.afterTokens)
  })

  it('keeps tool results attached to recent tool calls', () => {
    const messages: ReadonlyArray<AgentMessage> = [
      user('old context '.repeat(20)),
      assistant('old answer '.repeat(20)),
      user('use tool'),
      toolCallingAssistant(),
      toolResult()
    ]
    const result = compactWindowMessages(messages, { ...compactionOptions, tailMessageCount: 1 })

    if (result._tag !== 'Compacted') {
      throw new Error(`Expected compaction, got ${result._tag}`)
    }

    expect(result.messages[1]?._tag).toBe('Assistant')
    expect(result.messages.slice(-2)).toEqual(messages.slice(-2))
  })

  it.effect('creates a ContextTransformer layer', () =>
    Effect.gen(function* () {
      const transformer = yield* ContextTransformer
      const result = yield* transformer.transform([
        user('old context '.repeat(20)),
        assistant('old answer '.repeat(20)),
        user('recent')
      ])

      expect(result.events.map(event => event._tag)).toEqual(['CompactionStart', 'CompactionEnd'])
      const lastMessage = result.messages.at(-1)
      if (lastMessage?._tag !== 'User') {
        throw new Error('Expected recent user message')
      }
      expect(lastMessage.content).toBe('recent')
    }).pipe(Effect.provide(makeWindowCompactionTransformer(compactionOptions)))
  )

  it('builds checkpoint messages and drops a prior checkpoint from summary input', () => {
    const checkpoint = makeCompactionCheckpointMessage({
      summary: 'Summary text',
      recent: '[User]: recent',
      createdAtMs: 1
    })
    const next = user('continue')
    if (checkpoint._tag !== 'User') throw new Error('Expected user checkpoint')

    expect(checkpoint.content).toContain('<conversation-checkpoint>')
    expect(checkpoint.content).toContain('Summary text')
    expect(checkpoint.createdAtMs).toBe(1)
    expect(
      compactionSummarySourceMessages({
        hasPreviousSummary: true,
        messages: [checkpoint, next]
      })
    ).toEqual([next])
    expect(
      compactionSummarySourceMessages({
        hasPreviousSummary: false,
        messages: [checkpoint, next]
      })
    ).toEqual([checkpoint, next])
  })

  it('formats rich compaction source text', () => {
    const call = ToolCall.make({ id: 'call_1', name: 'lookup', params: { query: 'abc' } })
    const providerCall = ToolCall.make({
      id: 'provider_1',
      name: 'web',
      params: { url: 'x' }
    })
    const assistantMessage = AssistantAgentMessage.make({
      parts: [
        AssistantTextPart.make({ content: 'I will look' }),
        HostToolCallPart.make({ call }),
        AssistantReasoningPart.make({ text: 'checking' }),
        ProviderToolCallPart.make({ call: providerCall }),
        ProviderToolResultPart.make({
          toolCallId: providerCall.id,
          result: ToolResult.make({ toolCallId: providerCall.id, content: 'provider result' })
        }),
        AssistantTextPart.make({ content: 'done' })
      ]
    })
    const formatted = formatAgentMessagesForCompaction([
      user('hello'),
      assistantMessage,
      ToolResultMessage.make({
        toolCallId: 'call_1',
        content: 'result text that will truncate'
      })
    ], { maxToolOutputCharacters: 16 })

    expect(formatAgentMessageForCompaction(user('hello'))).toBe('[User]: hello')
    expect(formatted).toContain('[Assistant]: I will look')
    expect(formatted).toContain('[Assistant tool call]: lookup({"query":"abc"})')
    expect(formatted).toContain('[Assistant reasoning]: checking')
    expect(formatted).toContain('[Assistant provider tool call]: web({"url":"x"})')
    expect(formatted).toContain('[Assistant provider tool result provider_1]: provider result')
    expect(formatted).toContain('[Assistant]: done')
    expect(formatted).toContain('[Tool result call_1]: result text that\n[truncated]')
  })

  it.effect('retries context overflow once with compacted messages', () =>
    Effect.gen(function* () {
      const original = [user('original')]
      const compacted = [user('checkpoint')]
      const requests: Array<ReadonlyArray<AgentMessage>> = []
      const compactCalls: Array<ReadonlyArray<AgentMessage>> = []
      const messagesRef = yield* Ref.make<ReadonlyArray<AgentMessage>>(original)
      const provider: TestProvider = {
        stream: request => {
          requests.push(request.messages)
          if (requests.length === 1) return Stream.fail(contextOverflowError())

          return Stream.make(LLMTextDelta.make({ text: 'ok' }))
        }
      }
      const retryProvider = yield* makeContextOverflowRetryProvider({
        provider,
        messagesRef,
        compact: messages => {
          compactCalls.push(messages)
          return Effect.succeed({ _tag: 'Compacted', messages: compacted })
        }
      })

      const events = yield* retryProvider
        .stream({ messages: original, tools: [], model: 'test', systemPrompt: 'test' })
        .pipe(Stream.runCollect)

      expect(Array.from(events)).toEqual([LLMTextDelta.make({ text: 'ok' })])
      expect(requests).toEqual([original, compacted])
      expect(compactCalls).toEqual([original])
      expect(yield* Ref.get(messagesRef)).toEqual(compacted)
    })
  )

  it.effect('allows one context-overflow retry per provider stream', () =>
    Effect.gen(function* () {
      const originalA = [user('original-a')]
      const originalB = [user('original-b')]
      const compactedA = [user('checkpoint-a')]
      const compactedB = [user('checkpoint-b')]
      const requests: Array<ReadonlyArray<AgentMessage>> = []
      const compactCalls: Array<ReadonlyArray<AgentMessage>> = []
      const provider: TestProvider = {
        stream: request => {
          requests.push(request.messages)
          if (request.messages === originalA || request.messages === originalB) {
            return Stream.fail(contextOverflowError())
          }

          const text = request.messages === compactedA ? 'a' : 'b'

          return Stream.make(LLMTextDelta.make({ text }))
        }
      }
      const retryProvider = yield* makeContextOverflowRetryProvider({
        provider,
        compact: messages => {
          compactCalls.push(messages)

          return Effect.succeed({
            _tag: 'Compacted',
            messages: messages === originalA ? compactedA : compactedB
          })
        }
      })

      const eventsA = yield* retryProvider
        .stream({ messages: originalA, tools: [], model: 'test', systemPrompt: 'test' })
        .pipe(Stream.runCollect)
      const eventsB = yield* retryProvider
        .stream({ messages: originalB, tools: [], model: 'test', systemPrompt: 'test' })
        .pipe(Stream.runCollect)

      expect(Array.from(eventsA)).toEqual([LLMTextDelta.make({ text: 'a' })])
      expect(Array.from(eventsB)).toEqual([LLMTextDelta.make({ text: 'b' })])
      expect(requests).toEqual([originalA, compactedA, originalB, compactedB])
      expect(compactCalls).toEqual([originalA, originalB])
    })
  )

  it.effect('does not retry forever when compacted retry overflows', () =>
    Effect.gen(function* () {
      const original = [user('original')]
      const compacted = [user('checkpoint')]
      const overflow = contextOverflowError()
      const requests: Array<ReadonlyArray<AgentMessage>> = []
      const provider: TestProvider = {
        stream: request => {
          requests.push(request.messages)
          return Stream.fail(overflow)
        }
      }
      const retryProvider = yield* makeContextOverflowRetryProvider({
        provider,
        compact: () => Effect.succeed({ _tag: 'Compacted', messages: compacted })
      })

      const error = yield* retryProvider
        .stream({ messages: original, tools: [], model: 'test', systemPrompt: 'test' })
        .pipe(Stream.runCollect, Effect.flip)

      expect(error).toBe(overflow)
      expect(requests).toEqual([original, compacted])
    })
  )
})
