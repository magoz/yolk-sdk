import { Cause, Data, Effect, Exit, Ref, Result, Stream } from 'effect'
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

const isPureTypedFailure = <E>(cause: Cause.Cause<E>): boolean =>
  Cause.hasFails(cause) && !Cause.hasDies(cause) && !Cause.hasInterrupts(cause)

// Effect beta.80 Cause.map constructs `new Fail(mapped)` and drops Fail.annotations.
const mapFailReason = <E, E2>(reason: Cause.Fail<E>, error: E2): Cause.Fail<E2> =>
  Cause.makeFailReason(error).annotate(Cause.reasonAnnotations(reason))

const markSinkCause = <E2>(cause: Cause.Cause<E2>): Cause.Cause<CollectModelTurnSinkError<E2>> =>
  Cause.fromReasons(
    cause.reasons.map(reason =>
      Cause.isFailReason(reason)
        ? mapFailReason(reason, new CollectModelTurnSinkError({ error: reason.error }))
        : reason
    )
  )

const restoreAttemptCause = <E, E2>(
  cause: Cause.Cause<E | CollectModelTurnSinkError<E2>>
): Cause.Cause<E | E2> =>
  Cause.fromReasons(
    cause.reasons.map((reason): Cause.Reason<E | E2> => {
      if (!Cause.isFailReason(reason)) {
        return reason
      }
      if (reason.error instanceof CollectModelTurnSinkError) {
        return mapFailReason(reason, reason.error.error)
      }
      return mapFailReason(reason, reason.error)
    })
  )

const withSinkProvenance = <A, E2, R2>(
  effect: Effect.Effect<A, E2, R2>
): Effect.Effect<A, CollectModelTurnSinkError<E2>, R2> =>
  effect.pipe(
    Effect.exit,
    Effect.flatMap(exit =>
      Exit.isSuccess(exit)
        ? Effect.succeed(exit.value)
        : Effect.failCause(markSinkCause(exit.cause))
    )
  )

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
): Effect.Effect<CollectModelTurnAttemptResult<E, E2>, E | E2, R | R2> =>
  Effect.gen(function* () {
    const collection = yield* Ref.make(emptyCollection(options?.initialUsage))
    const onEvent = options?.onEvent
    const exit = yield* stream.pipe(
      Stream.runForEach(event =>
        Ref.update(collection, current => applyModelTurnEvent(current, event)).pipe(
          Effect.flatMap(() =>
            onEvent === undefined ? Effect.void : withSinkProvenance(onEvent(event))
          )
        )
      ),
      Effect.exit
    )
    const state = yield* Ref.get(collection)

    if (Exit.isSuccess(exit)) {
      return { _tag: 'Collected', collection: state }
    }

    if (!isPureTypedFailure(exit.cause)) {
      return yield* Effect.failCause(restoreAttemptCause(exit.cause))
    }

    const found = Cause.findError(exit.cause)
    if (Result.isFailure(found)) {
      return yield* Effect.failCause(restoreAttemptCause(exit.cause))
    }

    if (found.success instanceof CollectModelTurnSinkError) {
      return { _tag: 'SinkFailed', error: found.success.error, collection: state }
    }

    return { _tag: 'StreamFailed', error: found.success, collection: state }
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
