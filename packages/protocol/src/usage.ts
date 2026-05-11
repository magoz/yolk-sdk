import * as Schema from 'effect/Schema'

export class AgentInputUsage extends Schema.Class<AgentInputUsage>('AgentInputUsage')({
  total: Schema.Number,
  uncached: Schema.optional(Schema.Number),
  cacheRead: Schema.optional(Schema.Number),
  cacheWrite: Schema.optional(Schema.Number)
}) {}

export class AgentOutputUsage extends Schema.Class<AgentOutputUsage>('AgentOutputUsage')({
  total: Schema.Number,
  text: Schema.optional(Schema.Number),
  reasoning: Schema.optional(Schema.Number)
}) {}

export class AgentUsage extends Schema.Class<AgentUsage>('AgentUsage')({
  input: AgentInputUsage,
  output: AgentOutputUsage
}) {}

export const zeroAgentUsage = AgentUsage.make({
  input: AgentInputUsage.make({ total: 0 }),
  output: AgentOutputUsage.make({ total: 0 })
})

const sumOptional = (left: number | undefined, right: number | undefined) => {
  if (left === undefined && right === undefined) {
    return undefined
  }

  return (left ?? 0) + (right ?? 0)
}

export const addAgentUsage = (left: AgentUsage, right: AgentUsage) =>
  AgentUsage.make({
    input: AgentInputUsage.make({
      total: left.input.total + right.input.total,
      uncached: sumOptional(left.input.uncached, right.input.uncached),
      cacheRead: sumOptional(left.input.cacheRead, right.input.cacheRead),
      cacheWrite: sumOptional(left.input.cacheWrite, right.input.cacheWrite)
    }),
    output: AgentOutputUsage.make({
      total: left.output.total + right.output.total,
      text: sumOptional(left.output.text, right.output.text),
      reasoning: sumOptional(left.output.reasoning, right.output.reasoning)
    })
  })
