import type { AgentMessage } from '@yolk-sdk/agent/protocol'
import type { ContextTransformResult } from '@yolk-sdk/agent/loop'
import {
  compactWindowMessages,
  makePreviewSummaryMessage,
  makeWindowCompactionTransformer,
  type WindowCompactionOptions
} from '@yolk-sdk/agent/compaction'
import { agentTextContextBudget } from './context-budget'

export { estimateAgentMessagesTokens } from '@yolk-sdk/agent/compaction'

export const contextCompactionStrategy = 'window-summary-v1'

const exactTailMessageCount = 16
const summaryPreviewMaxCharacters = 180

const compactionOptions: WindowCompactionOptions = {
  strategy: contextCompactionStrategy,
  thresholdTokens: agentTextContextBudget.compactionInputTokens,
  tailMessageCount: exactTailMessageCount,
  makeSummaryMessage: messages =>
    makePreviewSummaryMessage(messages, { maxCharacters: summaryPreviewMaxCharacters })
}

export const compactAgentMessages = (
  messages: ReadonlyArray<AgentMessage>
): ContextTransformResult => compactWindowMessages(messages, compactionOptions)

export const AgentContextTransformerLayer = makeWindowCompactionTransformer(compactionOptions)
