import { Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  AssistantTextPart,
  HostToolCallPart,
  TextPart,
  ToolCall,
  ToolResultMessage,
  UserMessage,
  type AgentMessage
} from '@yolk-sdk/agent/protocol'
import { ContextTransformer } from '@yolk-sdk/agent/loop'
import {
  compactWindowMessages,
  contextBudgetStatus,
  contextBudgetUsageRatio,
  estimateAgentMessagesTokens,
  estimateAgentMessageTokens,
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
})
