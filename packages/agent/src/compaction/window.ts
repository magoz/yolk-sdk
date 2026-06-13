import {
  CompactionEnd,
  CompactionStart,
  type AgentEvent,
  type AgentMessage
} from '@yolk-sdk/agent/protocol'
import { estimateAgentMessagesTokens, type TranscriptTokenEstimator } from './estimator.ts'

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

export type SkippedCompactionPlan = {
  readonly _tag: 'Skip'
  readonly reason: CompactionSkipReason
  readonly messages: ReadonlyArray<AgentMessage>
  readonly beforeTokens: number
}

export type CompactCompactionPlan = {
  readonly _tag: 'Compact'
  readonly messages: ReadonlyArray<AgentMessage>
  readonly compactedMessages: ReadonlyArray<AgentMessage>
  readonly recentMessages: ReadonlyArray<AgentMessage>
  readonly tailStartIndex: number
  readonly beforeTokens: number
}

export type WindowCompactionPlan = SkippedCompactionPlan | CompactCompactionPlan

export type SkippedCompactionResult = {
  readonly _tag: 'Skipped'
  readonly reason: CompactionSkipReason
  readonly messages: ReadonlyArray<AgentMessage>
  readonly events: ReadonlyArray<AgentEvent>
  readonly beforeTokens: number
}

export type CompletedCompactionResult = {
  readonly _tag: 'Compacted'
  readonly strategy: string
  readonly messages: ReadonlyArray<AgentMessage>
  readonly events: ReadonlyArray<AgentEvent>
  readonly beforeTokens: number
  readonly afterTokens: number
  readonly compactedMessages: ReadonlyArray<AgentMessage>
  readonly recentMessages: ReadonlyArray<AgentMessage>
  readonly summaryMessage: AgentMessage
}

export type CompactionResult = SkippedCompactionResult | CompletedCompactionResult

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
): SkippedCompactionResult => ({
  _tag: 'Skipped',
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
    return { _tag: 'Skip', reason: 'too_few_messages', messages, beforeTokens }
  }

  if (beforeTokens < options.thresholdTokens) {
    return { _tag: 'Skip', reason: 'below_threshold', messages, beforeTokens }
  }

  const tailStart = windowTailStartIndex(
    messages,
    options.tailMessageCount ?? defaultCompactionTailMessageCount
  )
  const compactedMessages = messages.slice(0, tailStart)
  const recentMessages = messages.slice(tailStart)

  if (compactedMessages.length === 0 || recentMessages.length === 0) {
    return { _tag: 'Skip', reason: 'empty_window', messages, beforeTokens }
  }

  return {
    _tag: 'Compact',
    messages,
    compactedMessages,
    recentMessages,
    tailStartIndex: tailStart,
    beforeTokens
  }
}

export const applyCompactionPlan = (
  plan: WindowCompactionPlan,
  options: ApplyCompactionPlanOptions
): CompactionResult => {
  if (plan._tag === 'Skip') {
    return skippedCompactionResult(plan.reason, plan.messages, plan.beforeTokens)
  }

  const estimateTokens = estimator(options.estimateTokens)
  const messages = [options.summaryMessage, ...plan.recentMessages]
  const afterTokens = estimateTokens(messages)

  if (afterTokens >= plan.beforeTokens) {
    return skippedCompactionResult('not_smaller', plan.messages, plan.beforeTokens)
  }

  return {
    _tag: 'Compacted',
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
  }
}
