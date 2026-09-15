import { Effect, Match, Predicate, Stream, type Data } from 'effect'
import {
  HitlMatch as hitlMatch,
  OverflowCompactionResult as overflowCompactionResult,
  StepOutcome as stepOutcome
} from './outcome-constructors-internal.ts'
import {
  addAgentUsage,
  zeroAgentUsage,
  type AgentEvent,
  type AgentMessage,
  type AgentUsage,
  type HitlRequest,
  type HitlResponse
} from '@yolk-sdk/agent/protocol'
import {
  collectModelTurnAttempt,
  LLMError,
  runModelTurn,
  runToolBatch,
  type AgentLoopError,
  type ContextTransformer,
  type LLMProvider,
  type LoopConfig,
  type ModelTurnConfig,
  type ModelTurnResult,
  type ToolBatchConfig,
  type ToolExecutor
} from '@yolk-sdk/agent/loop'
import {
  applyOverflowCompaction,
  isOverflowCompactionAttemptCount
} from '@yolk-sdk/agent/compaction'

export type OverflowCompactionResult =
  | { readonly _tag: 'Compacted'; readonly messages: ReadonlyArray<AgentMessage> }
  | { readonly _tag: 'Skipped' }

export const OverflowCompactionResult = overflowCompactionResult

export type StepOutcome = Data.TaggedEnum<{
  Completed: {
    readonly needsContinuation: boolean
    readonly assistantMessage: ModelTurnResult['assistantMessage']
    readonly toolCalls: ModelTurnResult['toolCalls']
    readonly usage: ModelTurnResult['usage']
    readonly stopReason: ModelTurnResult['stopReason']
  }
  Retry: {
    readonly error: AgentLoopError
  }
  Continue: {
    readonly error: AgentLoopError
    readonly assistantMessage: ModelTurnResult['assistantMessage']
    readonly toolCalls: ModelTurnResult['toolCalls']
    readonly usage: ModelTurnResult['usage']
    readonly stopReason: ModelTurnResult['stopReason']
  }
  RecoverFull: {
    readonly error: AgentLoopError
  }
  Compacted: {
    readonly messages: ReadonlyArray<AgentMessage>
    readonly overflowCompactionAttempt: number
  }
  AwaitingInput: {
    readonly requests: ReadonlyArray<HitlRequest>
    readonly usage: AgentUsage
  }
}>

export const StepOutcome = stepOutcome

export type CompletedTurn = Extract<StepOutcome, { readonly _tag: 'Completed' }>

export type ModelTurnOutcome = Exclude<StepOutcome, { readonly _tag: 'AwaitingInput' }>

export type ToolBatchOutcome = Extract<
  StepOutcome,
  { readonly _tag: 'Completed' | 'AwaitingInput' }
>

const completedOutcome = (result: ModelTurnResult): CompletedTurn =>
  StepOutcome.Completed({
    needsContinuation: result.stopReason === 'tool_use',
    assistantMessage: result.assistantMessage,
    toolCalls: result.toolCalls,
    usage: result.usage,
    stopReason: result.stopReason
  })

const modelTurnResult = (result: ModelTurnResult): ModelTurnResult => ({
  assistantMessage: result.assistantMessage,
  toolCalls: result.toolCalls,
  usage: result.usage,
  stopReason: result.stopReason
})

const invalidOverflowCompactionAttemptError = () =>
  new LLMError({
    cause: 'validation_error',
    message: 'overflowCompactionAttempt must be a finite integer >= 0',
    retryable: false
  })

const isAgentLoopError = (error: unknown): error is AgentLoopError => {
  if (!Predicate.isObjectOrArray(error) || !('_tag' in error)) {
    return false
  }

  const tag = error._tag

  return (
    tag === 'LLMError' ||
    tag === 'FauxExhaustedError' ||
    tag === 'ToolError' ||
    tag === 'ContextTransformError' ||
    tag === 'AbortError'
  )
}

const isOverflow = (error: AgentLoopError) =>
  Match.value(error).pipe(
    Match.tag('LLMError', 'ContextTransformError', current => current.cause === 'context_overflow'),
    Match.orElse(() => false)
  )

const isMissingDone = (error: AgentLoopError) =>
  Match.value(error).pipe(
    Match.tag('LLMError', current => current.responseIssue === 'missing_done'),
    Match.orElse(() => false)
  )

const isRetryableLlm = (
  error: AgentLoopError
): error is Extract<AgentLoopError, { _tag: 'LLMError' }> =>
  Predicate.isTagged(error, 'LLMError') && error.retryable

const classifyModelTurnFailure = <E2, R2>(input: {
  readonly error: AgentLoopError
  readonly collected: ModelTurnResult
  readonly outputStarted: boolean
  readonly messages: ReadonlyArray<AgentMessage>
  readonly overflowCompactionAttempt: number
  readonly compact?: (
    messages: ReadonlyArray<AgentMessage>
  ) => Effect.Effect<OverflowCompactionResult, E2, R2>
}): Effect.Effect<ModelTurnOutcome, AgentLoopError | E2, R2> => {
  if (isOverflow(input.error)) {
    if (input.compact === undefined) {
      return Effect.fail(input.error)
    }

    return applyOverflowCompaction({
      compact: input.compact,
      messages: input.messages,
      attempt: input.overflowCompactionAttempt,
      outputStarted: input.outputStarted
    }).pipe(
      Effect.flatMap(result =>
        Match.value(result).pipe(
          Match.tag('Compacted', current =>
            Effect.succeed(
              StepOutcome.Compacted({
                messages: current.messages,
                overflowCompactionAttempt: input.overflowCompactionAttempt + 1
              })
            )
          ),
          Match.orElse(() => Effect.fail(input.error))
        )
      )
    )
  }

  if (isMissingDone(input.error) && !input.outputStarted) {
    return Effect.succeed(StepOutcome.RecoverFull({ error: input.error }))
  }

  if (isMissingDone(input.error) && input.outputStarted) {
    return Effect.succeed(
      StepOutcome.Continue({
        error: input.error,
        ...modelTurnResult(input.collected)
      })
    )
  }

  if (isRetryableLlm(input.error) && !input.outputStarted) {
    if (input.error.cause === 'invalid_response') {
      return Effect.succeed(StepOutcome.RecoverFull({ error: input.error }))
    }

    return Effect.succeed(StepOutcome.Retry({ error: input.error }))
  }

  if (isRetryableLlm(input.error) && input.outputStarted) {
    return Effect.succeed(
      StepOutcome.Continue({
        error: input.error,
        ...modelTurnResult(input.collected)
      })
    )
  }

  return Effect.fail(input.error)
}

export const attemptModelTurn = <E2 = never, R2 = never>(
  config: ModelTurnConfig,
  options?: {
    readonly onEvent?: (event: AgentEvent) => Effect.Effect<void, E2, R2>
    readonly initialUsage?: AgentUsage
    readonly overflowCompactionAttempt?: number
    readonly compact?: (
      messages: ReadonlyArray<AgentMessage>
    ) => Effect.Effect<OverflowCompactionResult, E2, R2>
  }
): Effect.Effect<
  ModelTurnOutcome,
  AgentLoopError | E2,
  ContextTransformer | LLMProvider | LoopConfig | R2
> =>
  Effect.gen(function* () {
    const overflowCompactionAttempt = options?.overflowCompactionAttempt ?? 0

    if (!isOverflowCompactionAttemptCount(overflowCompactionAttempt)) {
      return yield* Effect.fail(invalidOverflowCompactionAttemptError())
    }

    const outcome = yield* collectModelTurnAttempt(runModelTurn(config), {
      onEvent: options?.onEvent,
      initialUsage: options?.initialUsage
    })

    return yield* Match.value(outcome).pipe(
      Match.tag('Collected', current => Effect.succeed(completedOutcome(current.collection))),
      Match.tag('SinkFailed', current => Effect.fail(current.error)),
      Match.tag('StreamFailed', current => {
        if (!isAgentLoopError(current.error)) {
          return Effect.fail(current.error)
        }

        return classifyModelTurnFailure({
          error: current.error,
          collected: {
            assistantMessage:
              current.collection.assistantMessage ?? current.collection.partialAssistantMessage,
            toolCalls: current.collection.toolCalls,
            usage: current.collection.usage,
            stopReason: current.collection.stopReason
          },
          outputStarted: current.collection.outputStarted,
          messages: config.messages,
          overflowCompactionAttempt,
          compact: options?.compact
        })
      }),
      Match.exhaustive
    )
  })

type AttemptToolBatchFoldState = {
  requests: ReadonlyArray<HitlRequest>
  usage: AgentUsage
  toolCalls: ModelTurnResult['toolCalls']
}

export const attemptToolBatch = <E2 = never, R2 = never>(
  config: ToolBatchConfig,
  options?: {
    readonly onEvent?: (event: AgentEvent) => Effect.Effect<void, E2, R2>
  }
): Effect.Effect<ToolBatchOutcome, AgentLoopError | E2, LoopConfig | ToolExecutor | R2> => {
  const onEvent = options?.onEvent

  return runToolBatch(config).pipe(
    Stream.runFoldEffect(
      (): AttemptToolBatchFoldState => ({
        requests: [],
        usage: config.usage ?? zeroAgentUsage,
        toolCalls: []
      }),
      (acc, event) => {
        const next = Predicate.isTagged(event, 'AgentAwaitingInput')
          ? { ...acc, requests: event.requests, usage: event.usage }
          : Predicate.isTagged(event, 'UsageUpdate')
            ? { ...acc, usage: addAgentUsage(acc.usage, event.usage) }
            : Predicate.isTagged(event, 'ToolExecutionCompleted') ||
                Predicate.isTagged(event, 'ToolExecutionAccepted')
              ? { ...acc, toolCalls: [...acc.toolCalls, event.call] }
              : acc

        return onEvent === undefined ? Effect.succeed(next) : onEvent(event).pipe(Effect.as(next))
      }
    ),
    Effect.map((result): ToolBatchOutcome => {
      if (result.requests.length === 0) {
        const needsContinuation = result.toolCalls.length > 0

        return StepOutcome.Completed({
          needsContinuation,
          assistantMessage: undefined,
          toolCalls: result.toolCalls,
          usage: result.usage,
          stopReason: needsContinuation ? 'tool_use' : 'stop'
        })
      }

      return StepOutcome.AwaitingInput({ requests: result.requests, usage: result.usage })
    })
  )
}

export type HitlMatch =
  | { readonly _tag: 'Match'; readonly requestId: string }
  | { readonly _tag: 'Mismatch' }

export const HitlMatch = hitlMatch

const hitlResponseMatchesRequest = (response: HitlResponse, request: HitlRequest) =>
  Match.value(response).pipe(
    Match.tag(
      'ToolApprovalResponse',
      current =>
        Predicate.isTagged(request, 'ToolApprovalRequest') &&
        current.requestId === request.requestId &&
        current.toolCallId === request.toolCallId
    ),
    Match.tag(
      'QuestionResponse',
      current =>
        Predicate.isTagged(request, 'QuestionRequest') &&
        current.requestId === request.requestId &&
        current.toolCallId === request.toolCallId
    ),
    Match.exhaustive
  )

export const matchHitlResponse = (
  pending: ReadonlyArray<HitlRequest>,
  response: HitlResponse
): HitlMatch => {
  const matched = pending.find(request => hitlResponseMatchesRequest(response, request))

  return matched === undefined
    ? HitlMatch.Mismatch()
    : HitlMatch.Match({ requestId: matched.requestId })
}

export const resumeHitlIfMatched = <A, E, R>(input: {
  readonly pending: ReadonlyArray<HitlRequest>
  readonly response: HitlResponse
  readonly resume: (requestId: string) => Effect.Effect<A, E, R>
}): Effect.Effect<A | Extract<HitlMatch, { readonly _tag: 'Mismatch' }>, E, R> => {
  const matched = matchHitlResponse(input.pending, input.response)

  return Match.value(matched).pipe(
    Match.tag('Mismatch', current => Effect.succeed(current)),
    Match.tag('Match', current => input.resume(current.requestId)),
    Match.exhaustive
  )
}
