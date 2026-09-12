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
  | { readonly _tag: 'Failed'; readonly message: string }

const failureMessage = (error: unknown) => {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message)
  }
  return 'step failed'
}

const failedOutcome = (error: unknown): StepOutcome => ({
  _tag: 'Failed',
  message: failureMessage(error)
})

export const attemptModelTurn = <E2 = never, R2 = never>(
  config: ModelTurnConfig,
  options?: {
    readonly onEvent?: (event: AgentEvent) => Effect.Effect<void, E2, R2>
    readonly initialUsage?: AgentUsage
  }
): Effect.Effect<StepOutcome, never, ContextTransformer | LLMProvider | LoopConfig | R2> =>
  collectModelTurn(runModelTurn(config), options).pipe(
    Effect.map(
      (result): StepOutcome => ({
        _tag: 'Completed',
        needsContinuation: result.stopReason === 'tool_use',
        ...result
      })
    ),
    Effect.catch(error => Effect.succeed(failedOutcome(error)))
  )

export const attemptToolBatch = (
  config: ToolBatchConfig
): Effect.Effect<StepOutcome, never, LoopConfig | ToolExecutor> =>
  runToolBatch(config).pipe(
    Stream.runFoldEffect(
      (): { requests: ReadonlyArray<HitlRequest>; usage: AgentUsage } => ({
        requests: [],
        usage: config.usage ?? zeroAgentUsage
      }),
      (acc, event) => {
        if (event._tag === 'AgentAwaitingInput') {
          return Effect.succeed({ requests: event.requests, usage: event.usage })
        }
        if (event._tag === 'UsageUpdate') {
          return Effect.succeed({ ...acc, usage: addAgentUsage(acc.usage, event.usage) })
        }
        return Effect.succeed(acc)
      }
    ),
    Effect.map((result): StepOutcome => {
      if (result.requests.length === 0) {
        return {
          _tag: 'Completed',
          needsContinuation: false,
          assistantMessage: undefined,
          toolCalls: [],
          usage: result.usage,
          stopReason: 'stop'
        }
      }
      return { _tag: 'AwaitingInput', requests: result.requests, usage: result.usage }
    }),
    Effect.catch(error => Effect.succeed(failedOutcome(error)))
  )
