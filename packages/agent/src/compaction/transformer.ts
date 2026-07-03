import { Effect, Layer } from 'effect'
import type { AgentMessage } from '@yolk-sdk/agent/protocol'
import { ContextTransformer } from '@yolk-sdk/agent/loop'
import {
  applyCompactionPlan,
  planWindowCompaction,
  type CompactionResult,
  type SkippedCompactionPlan,
  type SkippedCompactionResult
} from './window.ts'
import type { TranscriptTokenEstimator } from './estimator.ts'

export type SummaryMessageFactory = (messages: ReadonlyArray<AgentMessage>) => AgentMessage

export type WindowCompactionOptions = {
  readonly strategy: string
  readonly thresholdTokens: number
  readonly tailMessageCount?: number
  readonly minMessages?: number
  readonly estimateTokens?: TranscriptTokenEstimator
  readonly makeSummaryMessage: SummaryMessageFactory
}

const skippedCompactionResult = (plan: SkippedCompactionPlan): SkippedCompactionResult => ({
  _tag: 'Skipped',
  reason: plan.reason,
  messages: plan.messages,
  events: [],
  beforeTokens: plan.beforeTokens
})

export const compactWindowMessages = (
  messages: ReadonlyArray<AgentMessage>,
  options: WindowCompactionOptions
): CompactionResult => {
  const plan = planWindowCompaction(messages, options)

  if (plan._tag === 'Skip') {
    return skippedCompactionResult(plan)
  }

  return applyCompactionPlan(plan, {
    strategy: options.strategy,
    summaryMessage: options.makeSummaryMessage(plan.compactedMessages),
    estimateTokens: options.estimateTokens
  })
}

export const makeWindowCompactionTransformer = (options: WindowCompactionOptions) =>
  Layer.succeed(
    ContextTransformer,
    ContextTransformer.of({
      transform: messages => Effect.succeed(compactWindowMessages(messages, options))
    })
  )
