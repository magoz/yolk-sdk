export type ContextBudget = {
  readonly contextWindowTokens: number
  readonly reservedOutputTokens: number
  readonly usableInputTokens: number
  readonly warningInputTokens: number
  readonly compactionInputTokens: number
}

export const makeContextBudget = (input: {
  readonly contextWindowTokens: number
  readonly reservedOutputTokens: number
  readonly warningRatio: number
  readonly compactionRatio: number
}): ContextBudget => {
  const usableInputTokens = Math.max(0, input.contextWindowTokens - input.reservedOutputTokens)

  return {
    contextWindowTokens: input.contextWindowTokens,
    reservedOutputTokens: input.reservedOutputTokens,
    usableInputTokens,
    warningInputTokens: Math.floor(usableInputTokens * input.warningRatio),
    compactionInputTokens: Math.floor(usableInputTokens * input.compactionRatio)
  }
}

export const agentTextContextBudget = makeContextBudget({
  contextWindowTokens: 200_000,
  reservedOutputTokens: 20_000,
  warningRatio: 0.8,
  compactionRatio: 1
})

export const contextBudgetUsageRatio = (tokens: number, budget: ContextBudget) =>
  budget.usableInputTokens === 0 ? 0 : tokens / budget.usableInputTokens

export type ContextBudgetStatus = 'idle' | 'normal' | 'warning' | 'compact'

export const contextBudgetStatus = (tokens: number, budget: ContextBudget): ContextBudgetStatus => {
  if (tokens <= 0) {
    return 'idle'
  }

  if (tokens >= budget.compactionInputTokens) {
    return 'compact'
  }

  return tokens >= budget.warningInputTokens ? 'warning' : 'normal'
}
