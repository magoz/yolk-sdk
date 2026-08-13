export type ContextBudget = {
  readonly contextWindowTokens: number
  readonly reservedOutputTokens: number
  readonly usableInputTokens: number
  readonly warningInputTokens: number
  readonly compactionInputTokens: number
}

export type ContextBudgetInput = {
  readonly contextWindowTokens: number
  readonly reservedOutputTokens: number
  /** Optional provider- or endpoint-specific ceiling below the model's total context window. */
  readonly maxInputTokens?: number
  readonly warningRatio: number
  readonly compactionRatio: number
}

export const makeContextBudget = (input: ContextBudgetInput): ContextBudget => {
  const contextUsableInputTokens = Math.max(
    0,
    input.contextWindowTokens - input.reservedOutputTokens
  )
  const maxInputTokens =
    input.maxInputTokens === undefined || !Number.isFinite(input.maxInputTokens)
      ? contextUsableInputTokens
      : Math.max(0, input.maxInputTokens)
  const usableInputTokens = Math.min(contextUsableInputTokens, maxInputTokens)

  return {
    contextWindowTokens: input.contextWindowTokens,
    reservedOutputTokens: input.reservedOutputTokens,
    usableInputTokens,
    warningInputTokens: Math.floor(usableInputTokens * input.warningRatio),
    compactionInputTokens: Math.floor(usableInputTokens * input.compactionRatio)
  }
}

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
