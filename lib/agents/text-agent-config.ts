import { textImageModelCapabilities, type AgentReasoningEffort } from '@yolk/agent/protocol'

export const defaultAgentSystemPrompt = 'You are Yolk assistant. Be concise and practical.'
export const openAiCodexTextModel = 'gpt-5.4'
export const anthropicClaudeTextModel = 'claude-sonnet-4-6'
export const agentTextModel = openAiCodexTextModel
export const agentTextModelOptions = [
  {
    model: openAiCodexTextModel,
    label: 'GPT-5.4',
    provider: 'openai-codex'
  },
  {
    model: anthropicClaudeTextModel,
    label: 'Claude Sonnet 4.6',
    provider: 'anthropic-claude'
  }
] as const
export const agentTextReasoningEffortOptions: ReadonlyArray<AgentReasoningEffort> = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh'
]
export const agentTextReasoningEffort: AgentReasoningEffort = 'low'
export const agentTextReasoningSummary = 'auto'
export const agentTextCapabilities = textImageModelCapabilities

export type AgentTextModel = (typeof agentTextModelOptions)[number]['model']
export const isAgentTextModel = (value: string): value is AgentTextModel =>
  agentTextModelOptions.some(option => option.model === value)
export const agentTextModelProvider = (model: AgentTextModel) =>
  agentTextModelOptions.find(option => option.model === model)?.provider ?? 'openai-codex'
export type AgentTextReasoningEffort = AgentReasoningEffort
export type AgentTextReasoningSummary = typeof agentTextReasoningSummary
