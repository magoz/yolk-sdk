import * as Schema from 'effect/Schema'

/**
 * How much a model reasons before it answers, lowest to highest. Supported values are model
 * dependent: `none` turns reasoning off where a model allows it, `max` is the top tier some models
 * add above `xhigh`. Each provider adapter lowers, passes through or rejects a value (see the
 * provider docs); hosts offer only the efforts their selected model accepts.
 */
export const AgentReasoningEffort = Schema.Literals([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])

export type AgentReasoningEffort = typeof AgentReasoningEffort.Type
