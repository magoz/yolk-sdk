import * as Schema from 'effect/Schema'

export class AgentContentCapabilities extends Schema.Class<AgentContentCapabilities>(
  'AgentContentCapabilities'
)({
  text: Schema.Boolean,
  image: Schema.Boolean,
  audio: Schema.Boolean
}) {}

export class AgentModelCapabilities extends Schema.Class<AgentModelCapabilities>(
  'AgentModelCapabilities'
)({
  input: AgentContentCapabilities,
  tools: Schema.Boolean,
  reasoning: Schema.Boolean
}) {}

export const textOnlyModelCapabilities = AgentModelCapabilities.make({
  input: AgentContentCapabilities.make({ text: true, image: false, audio: false }),
  tools: true,
  reasoning: true
})

export const textImageModelCapabilities = AgentModelCapabilities.make({
  input: AgentContentCapabilities.make({ text: true, image: true, audio: false }),
  tools: true,
  reasoning: true
})
