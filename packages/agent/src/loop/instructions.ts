import { Effect, Predicate } from 'effect'
import type * as Schema from 'effect/Schema'
import { latestInstructionState, UserMessage, type AgentMessage } from '@yolk-sdk/agent/protocol'

/**
 * A host instruction kept current in the conversation (ADR 0007), for example the code mode tool
 * catalog. Before each model request the loop compares `state` with the state of the latest
 * instruction message with the same `key` in the transcript; only when they differ it appends one
 * user-role instruction message whose content is `render({ previous, current })`. Earlier
 * messages never change, so a changing instruction never rewrites the cached request prefix, and
 * a redelivered step decides the same from the same transcript.
 */
export type RunInstruction = {
  readonly key: string
  /** The current state; `undefined` when the instruction no longer applies. */
  readonly state: Schema.Json | undefined
  /**
   * The model-visible text for a change: the first render (`previous` undefined), a delta or a
   * full replacement, or a removal notice (`current` undefined).
   */
  readonly render: (input: {
    readonly previous: Schema.Json | undefined
    readonly current: Schema.Json | undefined
  }) => string
}

/** Removed instructions keep this state, so a removal is recorded once. */
const removedState: Schema.Json = null

const isJsonObject = (value: Schema.Json): value is { readonly [key: string]: Schema.Json } =>
  Predicate.isObject(value) && !Array.isArray(value)

/** JSON with object keys sorted, so equal states compare equal whatever their key order (for
 * example after a round trip through a database JSON column).
 */
const canonicalJson = (value: Schema.Json): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`

  if (isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
      .join(',')}}`
  }

  return JSON.stringify(value)
}

const sameState = (left: Schema.Json, right: Schema.Json) =>
  canonicalJson(left) === canonicalJson(right)

/** The instruction messages a model request needs before it runs, in `instructions` order. */
export const instructionMessages = (
  messages: ReadonlyArray<AgentMessage>,
  instructions: ReadonlyArray<RunInstruction>
): ReadonlyArray<UserMessage> =>
  instructions.flatMap(instruction => {
    const recorded = latestInstructionState(messages, instruction.key)
    const previous = recorded === undefined || recorded === removedState ? undefined : recorded
    const current = instruction.state

    if (current === undefined) {
      if (previous === undefined) return []

      return [
        UserMessage.make({
          content: instruction.render({ previous, current: undefined }),
          instruction: { key: instruction.key, state: removedState }
        })
      ]
    }

    if (previous !== undefined && sameState(previous, current)) return []

    const content = instruction.render({ previous, current })

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
) =>
  Effect.sync(() => {
    const appended =
      instructions === undefined || instructions.length === 0
        ? []
        : instructionMessages(messages, instructions)

    return { messages: appended.length === 0 ? messages : [...messages, ...appended], appended }
  })
