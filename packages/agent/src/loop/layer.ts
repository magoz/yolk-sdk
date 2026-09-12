import { Effect, Layer } from 'effect'
import { ContextTransformer } from './services/context-transformer.ts'
import { LLMProvider } from './services/llm-provider.ts'
import { LoopConfig } from './services/loop-config.ts'
import { ToolExecutor } from './services/tool-executor.ts'

export const makeAgentLoopLayer = <PE, PR, TE = never, TR = never>(input: {
  readonly provider: Layer.Layer<LLMProvider, PE, PR>
  readonly tools?: Layer.Layer<ToolExecutor, TE, TR>
  readonly transformer?: Layer.Layer<ContextTransformer>
  readonly config?: Layer.Layer<LoopConfig>
}): Layer.Layer<LLMProvider | ToolExecutor | ContextTransformer | LoopConfig, PE | TE, PR | TR> =>
  Layer.mergeAll(
    input.provider,
    input.tools ?? ToolExecutor.unavailable,
    input.transformer ?? ContextTransformer.identity,
    input.config ?? LoopConfig.defaultLayer
  )

export const decorateLLMProvider = <E = never, R = never>(
  f: (
    provider: typeof LLMProvider.Service
  ) => typeof LLMProvider.Service | Effect.Effect<typeof LLMProvider.Service, E, R>
): Layer.Layer<LLMProvider, E, LLMProvider | R> =>
  Layer.effect(
    LLMProvider,
    Effect.flatMap(LLMProvider, provider => {
      const result = f(provider)

      return Effect.isEffect(result) ? result : Effect.succeed(result)
    })
  )
