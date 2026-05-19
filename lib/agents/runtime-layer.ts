import { Layer } from 'effect'
import { LoopConfig, type LLMProvider, type ToolExecutor } from '@yolk-sdk/agent/loop'
import { NoToolExecutorLayer } from './no-tool-executor-layer'
import { OpenAiProviderLayer } from './providers/openai-provider'
import { AgentContextTransformerLayer } from './context-transformer'

export const makeAgentRuntimeLayerWithTools = <
  ProviderError,
  ProviderRequirements,
  ToolError,
  ToolRequirements
>(
  providerLayer: Layer.Layer<LLMProvider, ProviderError, ProviderRequirements>,
  toolExecutorLayer: Layer.Layer<ToolExecutor, ToolError, ToolRequirements>
) =>
  Layer.mergeAll(
    AgentContextTransformerLayer,
    LoopConfig.defaultLayer,
    providerLayer,
    toolExecutorLayer
  )

export const makeAgentRuntimeLayer = <E, R>(providerLayer: Layer.Layer<LLMProvider, E, R>) =>
  makeAgentRuntimeLayerWithTools(providerLayer, NoToolExecutorLayer)

export const AgentRuntimeLayer = makeAgentRuntimeLayer(OpenAiProviderLayer)
