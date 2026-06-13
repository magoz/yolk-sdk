import { makeContextBudget as makeSharedContextBudget } from '@yolk-sdk/agent/compaction'

export {
  contextBudgetStatus,
  contextBudgetUsageRatio,
  makeContextBudget
} from '@yolk-sdk/agent/compaction'
export type { ContextBudget, ContextBudgetStatus } from '@yolk-sdk/agent/compaction'

export const agentTextContextBudget = makeSharedContextBudget({
  contextWindowTokens: 200_000,
  reservedOutputTokens: 20_000,
  warningRatio: 0.8,
  compactionRatio: 1
})
