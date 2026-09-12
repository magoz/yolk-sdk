import { Effect, Stream } from 'effect'
import {
  addAgentUsage,
  zeroAgentUsage,
  type AgentEvent,
  type AgentUsage,
  type HitlRequest
} from '@yolk-sdk/agent/protocol'
import {
  collectModelTurn,
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

export type StepOutcome =
  | ({ readonly _tag: 'Completed'; readonly needsContinuation: boolean } & ModelTurnResult)
  | {
      readonly _tag: 'AwaitingInput'
      readonly requests: ReadonlyArray<HitlRequest>
      readonly usage: AgentUsage
    }

const completedOutcome = (
  result: ModelTurnResult
): Extract<StepOutcome, { readonly _tag: 'Completed' }> => ({
  _tag: 'Completed',
  needsContinuation: result.stopReason === 'tool_use',
  ...result
})

export const attemptModelTurn = <E2 = never, R2 = never>(
  config: ModelTurnConfig,
  options?: {
    readonly onEvent?: (event: AgentEvent) => Effect.Effect<void, E2, R2>
    readonly initialUsage?: AgentUsage
  }
): Effect.Effect<
  Extract<StepOutcome, { readonly _tag: 'Completed' }>,
  AgentLoopError | E2,
  ContextTransformer | LLMProvider | LoopConfig | R2
> => collectModelTurn(runModelTurn(config), options).pipe(Effect.map(completedOutcome))

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
