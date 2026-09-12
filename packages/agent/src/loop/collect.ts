import { Effect, Stream } from 'effect'
import {
  addAgentUsage,
  zeroAgentUsage,
  type AgentEvent,
  type AgentMessage,
  type AgentUsage,
  type ToolCall
} from '@yolk-sdk/agent/protocol'

export type ModelTurnResult = {
  readonly assistantMessage: AgentMessage | undefined
  readonly toolCalls: ReadonlyArray<ToolCall>
  readonly usage: AgentUsage
  readonly stopReason: 'stop' | 'tool_use'
}

const applyModelTurnEvent = (acc: ModelTurnResult, event: AgentEvent): ModelTurnResult => {
  switch (event._tag) {
    case 'AssistantMessage':
      return { ...acc, assistantMessage: event.message }
    case 'ToolInputEnd':
      return { ...acc, toolCalls: [...acc.toolCalls, event.call] }
    case 'TurnEnd':
      return { ...acc, stopReason: event.reason }
    case 'UsageUpdate':
      return { ...acc, usage: addAgentUsage(acc.usage, event.usage) }
    default:
      return acc
  }
}

export const collectModelTurn = <E, R, E2 = never, R2 = never>(
  stream: Stream.Stream<AgentEvent, E, R>,
  options?: {
    readonly onEvent?: (event: AgentEvent) => Effect.Effect<void, E2, R2>
    readonly initialUsage?: AgentUsage
  }
): Effect.Effect<ModelTurnResult, E | E2, R | R2> => {
  const onEvent = options?.onEvent

  return stream.pipe(
    Stream.runFoldEffect(
      (): ModelTurnResult => ({
        assistantMessage: undefined,
        toolCalls: [],
        usage: options?.initialUsage ?? zeroAgentUsage,
        stopReason: 'stop'
      }),
      (acc, event) => {
        const next = applyModelTurnEvent(acc, event)
        return onEvent === undefined ? Effect.succeed(next) : onEvent(event).pipe(Effect.as(next))
      }
    )
  )
}
