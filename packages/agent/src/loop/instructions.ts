import type * as Schema from 'effect/Schema'
import {
  interactionJsonEquals,
  latestInstructionState,
  UserMessage,
  type AgentMessage
} from '@yolk-sdk/agent/protocol'

/**
 * A host instruction kept current in the conversation (ADR 0007), for example the code mode tool
 * catalog. Before each model request the loop compares `state` with the state of the latest
 * instruction message with the same `key` in the transcript; only when they differ it appends one
 * user-role instruction message whose content is `render(current)`. Earlier messages never change,
 * so a changing instruction never rewrites the cached request prefix, and a redelivered step
 * decides the same from the same transcript.
 */
export type RunInstruction = {
  readonly key: string
  /** The current state; `undefined` when the instruction no longer applies. */
  readonly state: Schema.Json | undefined
  /**
   * The model-visible text of a state, or a removal notice (`undefined`). Self-contained: it never
   * sees the previous state, because compaction keeps only the latest message of each key
   * (`latestInstructionMessages`), so that message alone must carry the whole instruction.
   */
  readonly render: (current: Schema.Json | undefined) => string
}

/**
 * The instruction messages a model request needs before it runs, in `instructions` order. States
 * compare as JSON values, independent of object key order. A removal is recorded once as an
 * instruction message without a state.
 */
export const instructionMessages = (
  messages: ReadonlyArray<AgentMessage>,
  instructions: ReadonlyArray<RunInstruction>
): ReadonlyArray<UserMessage> =>
  instructions.flatMap(instruction => {
    const previous = latestInstructionState(messages, instruction.key)
    const current = instruction.state

    if (current === undefined) {
      if (previous === undefined) return []

      return [
        UserMessage.make({
          content: instruction.render(undefined),
          instruction: { key: instruction.key }
        })
      ]
    }

    if (previous !== undefined && interactionJsonEquals(previous, current)) return []

    const content = instruction.render(current)

    return content.trim().length === 0
      ? []
      : [UserMessage.make({ content, instruction: { key: instruction.key, state: current } })]
  })

/**
 * The instruction messages a request needs, appended. They join the run's created messages (so
 * hosts persist them with the turn) but emit no `UserMessage` event: they are not user input.
 */
export const withInstructionMessages = (
  messages: ReadonlyArray<AgentMessage>,
  instructions: ReadonlyArray<RunInstruction> | undefined
) => {
  const appended =
    instructions === undefined || instructions.length === 0
      ? []
      : instructionMessages(messages, instructions)

  return { messages: appended.length === 0 ? messages : [...messages, ...appended], appended }
}
