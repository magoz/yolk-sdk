import * as Schema from 'effect/Schema'

export const AgentReasoningEffort = Schema.Literals(['minimal', 'low', 'medium', 'high', 'xhigh'])
export type AgentReasoningEffort = typeof AgentReasoningEffort.Type
