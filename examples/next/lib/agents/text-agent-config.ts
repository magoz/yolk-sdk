import {
  textImageDocumentModelCapabilities,
  type AgentReasoningEffort
} from '@yolk-sdk/agent/protocol'

export const openAiCodexTextModel = 'gpt-5.5'
export const anthropicClaudeTextModel = 'claude-sonnet-4-6'
export const agentTextModel = openAiCodexTextModel
const agentTextModelConfigById = {
  [openAiCodexTextModel]: {
    model: openAiCodexTextModel,
    label: 'GPT-5.5',
    provider: 'openai-codex',
    maxOutputTokens: 128_000
  },
  [anthropicClaudeTextModel]: {
    model: anthropicClaudeTextModel,
    label: 'Claude Sonnet 4.6',
    provider: 'anthropic-claude',
    maxOutputTokens: 64_000
  }
} as const
export const agentTextModelOptions = Object.values(agentTextModelConfigById)
export const agentTextReasoningEffortOptions: ReadonlyArray<AgentReasoningEffort> = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh'
]
export const agentTextReasoningEffort: AgentReasoningEffort = 'low'
export const agentTextReasoningSummary = 'auto'
export const agentTextCapabilities = textImageDocumentModelCapabilities

export type AgentTextModel = keyof typeof agentTextModelConfigById
export const isAgentTextModel = (value: string): value is AgentTextModel =>
  agentTextModelOptions.some(option => option.model === value)
export const agentTextModelProvider = (model: AgentTextModel) =>
  agentTextModelConfigById[model].provider
export const agentTextModelMaxOutputTokens = (model: AgentTextModel) =>
  agentTextModelConfigById[model].maxOutputTokens
export type AgentTextReasoningEffort = AgentReasoningEffort
export type AgentTextReasoningSummary = typeof agentTextReasoningSummary
