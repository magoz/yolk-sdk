import { Data, Effect, Ref, Stream } from 'effect'
import {
  AssistantAgentMessage,
  addAgentUsage,
  zeroAgentUsage,
  type AgentEvent,
  type AgentMessage,
  type AgentUsage,
  type AssistantPart,
  type ToolCall
} from '@yolk-sdk/agent/protocol'
import { applyAssistantLlmEvent } from './accumulator.ts'
import {
  LLMProviderToolResult,
  LLMReasoningDelta,
  LLMTextDelta,
  LLMToolCall,
  type LLMEvent
} from './llm-event.ts'

export type ModelTurnResult = {
  readonly assistantMessage: AgentMessage | undefined
  readonly toolCalls: ReadonlyArray<ToolCall>
  readonly usage: AgentUsage
  readonly stopReason: 'stop' | 'tool_use'
}

export type ModelTurnCollection = ModelTurnResult & {
  readonly outputStarted: boolean
  readonly partialAssistantMessage: AgentMessage | undefined
}

export type CollectModelTurnAttemptResult<E, E2 = never> =
  | { readonly _tag: 'Collected'; readonly collection: ModelTurnCollection }
  | { readonly _tag: 'StreamFailed'; readonly error: E; readonly collection: ModelTurnCollection }
  | { readonly _tag: 'SinkFailed'; readonly error: E2; readonly collection: ModelTurnCollection }

class CollectModelTurnSinkError<E2> extends Data.TaggedError('CollectModelTurnSinkError')<{
  readonly error: E2
}> {}

const emptyCollection = (initialUsage?: AgentUsage): ModelTurnCollection => ({
  assistantMessage: undefined,
  toolCalls: [],
  usage: initialUsage ?? zeroAgentUsage,
  stopReason: 'stop',
  outputStarted: false,
  partialAssistantMessage: undefined
})

const toModelTurnResult = (collection: ModelTurnCollection): ModelTurnResult => ({
  assistantMessage: collection.assistantMessage,
  toolCalls: collection.toolCalls,
  usage: collection.usage,
  stopReason: collection.stopReason
})

const eventStartsOutput = (event: AgentEvent) => {
  switch (event._tag) {
    case 'LLMTextDelta':
    case 'LLMReasoningDelta':
    case 'AssistantMessage':
    case 'ToolInputStart':
    case 'ToolInputDelta':
    case 'ToolInputEnd':
    case 'ProviderToolResult':
      return true
    default:
      return false
  }
}

const llmEventFromAgentEvent = (event: AgentEvent): LLMEvent | undefined => {
  switch (event._tag) {
    case 'LLMTextDelta':
      return LLMTextDelta.make({ text: event.text })
    case 'LLMReasoningDelta':
      return LLMReasoningDelta.make({ text: event.text })
    case 'ToolInputEnd':
      return LLMToolCall.make({ call: event.call })
    case 'ProviderToolResult':
      return LLMProviderToolResult.make({ call: event.call, result: event.result })
    default:
      return undefined
  }
}

const assistantParts = (message: AgentMessage | undefined): ReadonlyArray<AssistantPart> =>
  message?._tag === 'Assistant' ? message.parts : []

const withAssistantParts = (parts: ReadonlyArray<AssistantPart>): AgentMessage | undefined =>
  parts.length === 0 ? undefined : AssistantAgentMessage.make({ parts })

const applyPartialAssistant = (
  message: AgentMessage | undefined,
  event: AgentEvent
): AgentMessage | undefined => {
  const llmEvent = llmEventFromAgentEvent(event)
  if (llmEvent === undefined) return message
  return withAssistantParts(applyAssistantLlmEvent(assistantParts(message), llmEvent))
}

const applyModelTurnEvent = (acc: ModelTurnCollection, event: AgentEvent): ModelTurnCollection => {
  const outputStarted = acc.outputStarted || eventStartsOutput(event)
  const partialAssistantMessage =
    event._tag === 'AssistantMessage'
      ? event.message
      : applyPartialAssistant(acc.partialAssistantMessage, event)

  switch (event._tag) {
    case 'AssistantMessage':
      return {
        ...acc,
        assistantMessage: event.message,
        partialAssistantMessage,
        outputStarted
      }
    case 'ToolInputEnd':
      return {
        ...acc,
        toolCalls: [...acc.toolCalls, event.call],
        partialAssistantMessage,
        outputStarted
      }
    case 'TurnEnd':
      return { ...acc, stopReason: event.reason, partialAssistantMessage, outputStarted }
    case 'UsageUpdate':
      return {
        ...acc,
        usage: addAgentUsage(acc.usage, event.usage),
        partialAssistantMessage,
        outputStarted
      }
    default:
      return { ...acc, partialAssistantMessage, outputStarted }
  }
}

export const collectModelTurnAttempt = <E, R, E2 = never, R2 = never>(
  stream: Stream.Stream<AgentEvent, E, R>,
  options?: {
    readonly onEvent?: (event: AgentEvent) => Effect.Effect<void, E2, R2>
    readonly initialUsage?: AgentUsage
  }
): Effect.Effect<CollectModelTurnAttemptResult<E, E2>, never, R | R2> =>
  Effect.gen(function* () {
    const collection = yield* Ref.make(emptyCollection(options?.initialUsage))
    const onEvent = options?.onEvent
    const result = yield* stream.pipe(
      Stream.runForEach(event =>
        Ref.update(collection, current => applyModelTurnEvent(current, event)).pipe(
          Effect.flatMap(() =>
            onEvent === undefined
              ? Effect.void
              : onEvent(event).pipe(
                  Effect.mapError(error => new CollectModelTurnSinkError({ error }))
                )
          )
        )
      ),
      Effect.result
    )
    const state = yield* Ref.get(collection)

    if (result._tag === 'Success') {
      return { _tag: 'Collected', collection: state }
    }

    if (result.failure instanceof CollectModelTurnSinkError) {
      return { _tag: 'SinkFailed', error: result.failure.error, collection: state }
    }

    return { _tag: 'StreamFailed', error: result.failure, collection: state }
  })

export const collectModelTurn = <E, R, E2 = never, R2 = never>(
  stream: Stream.Stream<AgentEvent, E, R>,
  options?: {
    readonly onEvent?: (event: AgentEvent) => Effect.Effect<void, E2, R2>
    readonly initialUsage?: AgentUsage
  }
): Effect.Effect<ModelTurnResult, E | E2, R | R2> =>
  collectModelTurnAttempt(stream, options).pipe(
    Effect.flatMap((outcome): Effect.Effect<ModelTurnResult, E | E2> => {
      if (outcome._tag === 'Collected') {
        return Effect.succeed(toModelTurnResult(outcome.collection))
      }
      return Effect.fail(outcome.error)
    })
  )
