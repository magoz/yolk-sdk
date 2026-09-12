import { Effect, Stream } from 'effect'
import {
  addAgentUsage,
  zeroAgentUsage,
  type AgentEvent,
  type AgentMessage,
  type AgentUsage,
  type HitlRequest
} from '@yolk-sdk/agent/protocol'
import {
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

export type OverflowCompactionResult =
  | {
      readonly _tag: 'Compacted'
      readonly messages: ReadonlyArray<AgentMessage>
    }
  | {
      readonly _tag: 'Skipped'
    }

export type StepOutcome =
  | ({ readonly _tag: 'Completed'; readonly needsContinuation: boolean } & ModelTurnResult)
  | {
      readonly _tag: 'AwaitingInput'
      readonly requests: ReadonlyArray<HitlRequest>
      readonly usage: AgentUsage
    }
  | { readonly _tag: 'Retry'; readonly error: AgentLoopError }
  | ({ readonly _tag: 'Continue'; readonly error: AgentLoopError } & ModelTurnResult)
  | { readonly _tag: 'RecoverFull'; readonly error: AgentLoopError }
  | {
      readonly _tag: 'Compacted'
      readonly messages: ReadonlyArray<AgentMessage>
    }

const completedOutcome = (
  result: ModelTurnResult
): Extract<StepOutcome, { readonly _tag: 'Completed' }> => ({
  _tag: 'Completed',
  needsContinuation: result.stopReason === 'tool_use',
  ...result
})

const emptyTurn = (initialUsage?: AgentUsage): ModelTurnResult => ({
  assistantMessage: undefined,
  toolCalls: [],
  usage: initialUsage ?? zeroAgentUsage,
  stopReason: 'stop'
})

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

const eventStartsOutput = (event: AgentEvent) =>
  event._tag === 'LLMTextDelta' ||
  event._tag === 'AssistantMessage' ||
  event._tag === 'ToolInputStart' ||
  event._tag === 'ToolInputEnd'

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

const isRetryableLlm = (
  error: AgentLoopError
): error is Extract<AgentLoopError, { _tag: 'LLMError' }> =>
  error._tag === 'LLMError' && error.retryable

const classifyModelTurnFailure = <E2, R2>(input: {
  readonly error: AgentLoopError
  readonly collected: ModelTurnResult
  readonly outputStarted: boolean
  readonly messages: ReadonlyArray<AgentMessage>
  readonly compact?: (
    messages: ReadonlyArray<AgentMessage>
  ) => Effect.Effect<OverflowCompactionResult, E2, R2>
}): Effect.Effect<StepOutcome, AgentLoopError | E2, R2> => {
  if (isOverflow(input.error)) {
    if (input.outputStarted || input.compact === undefined) {
      return Effect.fail(input.error)
    }

    return input.compact(input.messages).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.fail(input.error),
        onSuccess: result =>
          result._tag === 'Compacted'
            ? Effect.succeed({ _tag: 'Compacted', messages: result.messages })
            : Effect.fail(input.error)
      })
    )
  }

  if (isRetryableLlm(input.error) && !input.outputStarted) {
    if (input.error.cause === 'invalid_response') {
      return Effect.succeed({ _tag: 'RecoverFull', error: input.error })
    }
    return Effect.succeed({ _tag: 'Retry', error: input.error })
  }

  if (isRetryableLlm(input.error) && input.outputStarted) {
    return Effect.succeed({ _tag: 'Continue', error: input.error, ...input.collected })
  }

  return Effect.fail(input.error)
}

export const attemptModelTurn = <E2 = never, R2 = never>(
  config: ModelTurnConfig,
  options?: {
    readonly onEvent?: (event: AgentEvent) => Effect.Effect<void, E2, R2>
    readonly initialUsage?: AgentUsage
    readonly compact?: (
      messages: ReadonlyArray<AgentMessage>
    ) => Effect.Effect<OverflowCompactionResult, E2, R2>
  }
): Effect.Effect<
  StepOutcome,
  AgentLoopError | E2,
  ContextTransformer | LLMProvider | LoopConfig | R2
> => {
  const onEvent = options?.onEvent
  let collected = emptyTurn(options?.initialUsage)
  let outputStarted = false

  return runModelTurn(config).pipe(
    Stream.runFoldEffect((): ModelTurnResult => emptyTurn(options?.initialUsage), (acc, event) => {
      const next = applyModelTurnEvent(acc, event)
      collected = next
      if (eventStartsOutput(event)) {
        outputStarted = true
      }
      return onEvent === undefined ? Effect.succeed(next) : onEvent(event).pipe(Effect.as(next))
    }),
    Effect.map(completedOutcome),
    Effect.catch((error: AgentLoopError | E2) =>
      isAgentLoopError(error)
        ? classifyModelTurnFailure({
            error,
            collected,
            outputStarted,
            messages: config.messages,
            compact: options?.compact
          })
        : Effect.fail(error)
    )
  )
}

export const attemptToolBatch = <E2 = never, R2 = never>(
  config: ToolBatchConfig,
  options?: {
    readonly onEvent?: (event: AgentEvent) => Effect.Effect<void, E2, R2>
  }
): Effect.Effect<StepOutcome, AgentLoopError | E2, LoopConfig | ToolExecutor | R2> => {
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
        const next =
          event._tag === 'AgentAwaitingInput'
            ? { ...acc, requests: event.requests, usage: event.usage }
            : event._tag === 'UsageUpdate'
              ? { ...acc, usage: addAgentUsage(acc.usage, event.usage) }
              : event._tag === 'ToolExecutionCompleted' || event._tag === 'ToolExecutionAccepted'
                ? { ...acc, toolCalls: [...acc.toolCalls, event.call] }
                : acc
        return onEvent === undefined ? Effect.succeed(next) : onEvent(event).pipe(Effect.as(next))
      }
    ),
    Effect.map((result): StepOutcome => {
      if (result.requests.length === 0) {
        return {
          _tag: 'Completed',
          needsContinuation: false,
          assistantMessage: undefined,
          toolCalls: result.toolCalls,
          usage: result.usage,
          stopReason: 'stop'
        }
      }
      return { _tag: 'AwaitingInput', requests: result.requests, usage: result.usage }
    })
  )
}
