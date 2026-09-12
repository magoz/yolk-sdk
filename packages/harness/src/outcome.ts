import { Effect, Predicate, Stream } from 'effect'
import {
  addAgentUsage,
  zeroAgentUsage,
  type AgentEvent,
  type AgentMessage,
  type AgentUsage,
  type HitlRequest
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
  | {
      readonly _tag: 'Compacted'
      readonly messages: ReadonlyArray<AgentMessage>
    }
  | {
      readonly _tag: 'Skipped'
    }

export type CompletedTurn = {
  readonly _tag: 'Completed'
  readonly needsContinuation: boolean
} & ModelTurnResult

export type ModelTurnOutcome =
  | CompletedTurn
  | { readonly _tag: 'Retry'; readonly error: AgentLoopError }
  | ({ readonly _tag: 'Continue'; readonly error: AgentLoopError } & ModelTurnResult)
  | { readonly _tag: 'RecoverFull'; readonly error: AgentLoopError }
  | {
      readonly _tag: 'Compacted'
      readonly messages: ReadonlyArray<AgentMessage>
      readonly overflowCompactionAttempt: number
    }

export type ToolBatchOutcome =
  | CompletedTurn
  | {
      readonly _tag: 'AwaitingInput'
      readonly requests: ReadonlyArray<HitlRequest>
      readonly usage: AgentUsage
    }

export type StepOutcome = ModelTurnOutcome | ToolBatchOutcome

const completedOutcome = (result: ModelTurnResult): CompletedTurn => ({
  _tag: 'Completed',
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
  if (typeof error !== 'object' || error === null || !('_tag' in error)) {
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
  (error._tag === 'LLMError' || error._tag === 'ContextTransformError') &&
  error.cause === 'context_overflow'

const isMissingDone = (error: AgentLoopError) =>
  error._tag === 'LLMError' && error.responseIssue === 'missing_done'

const isRetryableLlm = (
  error: AgentLoopError
): error is Extract<AgentLoopError, { _tag: 'LLMError' }> =>
  error._tag === 'LLMError' && error.retryable

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
        result._tag === 'Compacted'
          ? Effect.succeed({
              _tag: 'Compacted' as const,
              messages: result.messages,
              overflowCompactionAttempt: input.overflowCompactionAttempt + 1
            })
          : Effect.fail(input.error)
      )
    )
  }

  if (isMissingDone(input.error) && !input.outputStarted) {
    return Effect.succeed({ _tag: 'RecoverFull', error: input.error })
  }

  if (isMissingDone(input.error) && input.outputStarted) {
    return Effect.succeed({
      _tag: 'Continue',
      error: input.error,
      ...modelTurnResult(input.collected)
    })
  }

  if (isRetryableLlm(input.error) && !input.outputStarted) {
    if (input.error.cause === 'invalid_response') {
      return Effect.succeed({ _tag: 'RecoverFull', error: input.error })
    }

    return Effect.succeed({ _tag: 'Retry', error: input.error })
  }

  if (isRetryableLlm(input.error) && input.outputStarted) {
    return Effect.succeed({
      _tag: 'Continue',
      error: input.error,
      ...modelTurnResult(input.collected)
    })
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

    switch (outcome._tag) {
      case 'Collected':
        return completedOutcome(outcome.collection)
      case 'SinkFailed':
        return yield* Effect.fail(outcome.error)
      case 'StreamFailed':
        if (!isAgentLoopError(outcome.error)) {
          return yield* Effect.fail(outcome.error)
        }

        return yield* classifyModelTurnFailure({
          error: outcome.error,
          collected: {
            assistantMessage:
              outcome.collection.assistantMessage ?? outcome.collection.partialAssistantMessage,
            toolCalls: outcome.collection.toolCalls,
            usage: outcome.collection.usage,
            stopReason: outcome.collection.stopReason
          },
          outputStarted: outcome.collection.outputStarted,
          messages: config.messages,
          overflowCompactionAttempt,
          compact: options?.compact
        })
    }
  })

export const attemptToolBatch = <E2 = never, R2 = never>(
  config: ToolBatchConfig,
  options?: {
    readonly onEvent?: (event: AgentEvent) => Effect.Effect<void, E2, R2>
  }
): Effect.Effect<ToolBatchOutcome, AgentLoopError | E2, LoopConfig | ToolExecutor | R2> => {
  const onEvent = options?.onEvent

  return runToolBatch(config).pipe(
    Stream.runFoldEffect(
      (): {
        requests: ReadonlyArray<HitlRequest>
        usage: AgentUsage
        toolCalls: ModelTurnResult['toolCalls']
      } => ({
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

        return {
          _tag: 'Completed',
          needsContinuation,
          assistantMessage: undefined,
          toolCalls: result.toolCalls,
          usage: result.usage,
          stopReason: needsContinuation ? 'tool_use' : 'stop'
        }
      }

      return { _tag: 'AwaitingInput', requests: result.requests, usage: result.usage }
    })
  )
}
