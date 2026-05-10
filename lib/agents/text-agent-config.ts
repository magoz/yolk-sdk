import type { AgentReasoningEffort } from '@yolk/protocol'

export const defaultAgentSystemPrompt = 'You are Yolk assistant. Be concise and practical.'
export const agentTextModel = 'gpt-5.4'
export const agentTextReasoningEffortOptions: ReadonlyArray<AgentReasoningEffort> = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh'
]
export const agentTextReasoningEffort: AgentReasoningEffort = 'low'
export const agentTextReasoningSummary = 'auto'

export type AgentTextReasoningEffort = AgentReasoningEffort
export type AgentTextReasoningSummary = typeof agentTextReasoningSummary
