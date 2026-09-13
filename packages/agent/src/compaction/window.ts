import {
  CompactionEnd,
  CompactionStart,
  type AgentEvent,
  type AgentMessage
} from '@yolk-sdk/agent/protocol'
import { estimateAgentMessagesTokens, type TranscriptTokenEstimator } from './estimator.ts'
import { Data, Predicate } from 'effect'

export const defaultCompactionTailMessageCount = 16

export const defaultMinimumCompactionMessages = 2

export type CompactionSkipReason =
  | 'too_few_messages'
  | 'below_threshold'
  | 'empty_window'
  | 'not_smaller'

export type WindowCompactionPlanOptions = {
  readonly thresholdTokens: number
  readonly tailMessageCount?: number
  readonly minMessages?: number
  readonly estimateTokens?: TranscriptTokenEstimator
}

export type WindowCompactionPlan = Data.TaggedEnum<{
  Skip: {
    readonly reason: CompactionSkipReason
    readonly messages: ReadonlyArray<AgentMessage>
    readonly beforeTokens: number
  }
  Compact: {
    readonly messages: ReadonlyArray<AgentMessage>
    readonly compactedMessages: ReadonlyArray<AgentMessage>
    readonly recentMessages: ReadonlyArray<AgentMessage>
    readonly tailStartIndex: number
    readonly beforeTokens: number
  }
}>

export type SkippedCompactionPlan = Extract<WindowCompactionPlan, { readonly _tag: 'Skip' }>

export type CompactCompactionPlan = Extract<WindowCompactionPlan, { readonly _tag: 'Compact' }>

const WindowCompactionPlan = Data.taggedEnum<WindowCompactionPlan>()

export type CompactionResult = Data.TaggedEnum<{
  Skipped: {
    readonly reason: CompactionSkipReason
    readonly messages: ReadonlyArray<AgentMessage>
    readonly events: ReadonlyArray<AgentEvent>
    readonly beforeTokens: number
  }
  Compacted: {
    readonly strategy: string
    readonly messages: ReadonlyArray<AgentMessage>
    readonly events: ReadonlyArray<AgentEvent>
    readonly beforeTokens: number
    readonly afterTokens: number
    readonly compactedMessages: ReadonlyArray<AgentMessage>
    readonly recentMessages: ReadonlyArray<AgentMessage>
    readonly summaryMessage: AgentMessage
  }
}>

export type SkippedCompactionResult = Extract<CompactionResult, { readonly _tag: 'Skipped' }>

export type CompletedCompactionResult = Extract<CompactionResult, { readonly _tag: 'Compacted' }>

export const CompactionResult = Data.taggedEnum<CompactionResult>()

export type ApplyCompactionPlanOptions = {
  readonly strategy: string
  readonly summaryMessage: AgentMessage
  readonly estimateTokens?: TranscriptTokenEstimator
}

const estimator = (estimateTokens?: TranscriptTokenEstimator) =>
  estimateTokens ?? estimateAgentMessagesTokens

const skippedCompactionResult = (
  reason: CompactionSkipReason,
  messages: ReadonlyArray<AgentMessage>,
  beforeTokens: number
): SkippedCompactionResult =>
  CompactionResult.Skipped({
    reason,
    messages,
    events: [],
    beforeTokens
  })

export const windowTailStartIndex = (
  messages: ReadonlyArray<AgentMessage>,
  tailMessageCount: number
) => {
  const tailCount = Math.min(Math.max(0, tailMessageCount), Math.max(0, messages.length - 1))
  const initialIndex = Math.max(1, messages.length - tailCount)
  let index = initialIndex

  while (index > 1 && messages[index]?._tag === 'ToolResult') {
    index -= 1
  }

  return index
}

export const planWindowCompaction = (
  messages: ReadonlyArray<AgentMessage>,
  options: WindowCompactionPlanOptions
): WindowCompactionPlan => {
  const estimateTokens = estimator(options.estimateTokens)
  const beforeTokens = estimateTokens(messages)
  const minMessages = options.minMessages ?? defaultMinimumCompactionMessages

  if (messages.length <= minMessages) {
    return WindowCompactionPlan.Skip({
      reason: 'too_few_messages',
      messages,
      beforeTokens
    })
  }

  if (beforeTokens < options.thresholdTokens) {
    return WindowCompactionPlan.Skip({
      reason: 'below_threshold',
      messages,
      beforeTokens
    })
  }

  const tailStart = windowTailStartIndex(
    messages,
    options.tailMessageCount ?? defaultCompactionTailMessageCount
  )

  const compactedMessages = messages.slice(0, tailStart)
  const recentMessages = messages.slice(tailStart)

  if (compactedMessages.length === 0 || recentMessages.length === 0) {
    return WindowCompactionPlan.Skip({
      reason: 'empty_window',
      messages,
      beforeTokens
    })
  }

  return WindowCompactionPlan.Compact({
    messages,
    compactedMessages,
    recentMessages,
    tailStartIndex: tailStart,
    beforeTokens
  })
}

export const applyCompactionPlan = (
  plan: WindowCompactionPlan,
  options: ApplyCompactionPlanOptions
): CompactionResult => {
  if (Predicate.isTagged(plan, 'Skip')) {
    return skippedCompactionResult(plan.reason, plan.messages, plan.beforeTokens)
  }

  const estimateTokens = estimator(options.estimateTokens)
  const messages = [options.summaryMessage, ...plan.recentMessages]
  const afterTokens = estimateTokens(messages)

  if (afterTokens >= plan.beforeTokens) {
    return skippedCompactionResult('not_smaller', plan.messages, plan.beforeTokens)
  }

  return CompactionResult.Compacted({
    strategy: options.strategy,
    messages,
    events: [
      CompactionStart.make({ strategy: options.strategy }),
      CompactionEnd.make({
        strategy: options.strategy,
        beforeTokens: plan.beforeTokens,
        afterTokens
      })
    ],
    beforeTokens: plan.beforeTokens,
    afterTokens,
    compactedMessages: plan.compactedMessages,
    recentMessages: plan.recentMessages,
    summaryMessage: options.summaryMessage
  })
}
