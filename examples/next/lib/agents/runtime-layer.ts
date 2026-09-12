import type { Layer } from 'effect'
import {
  LoopConfig,
  makeAgentLoopLayer,
  type LLMProvider,
  type ToolExecutor
} from '@yolk-sdk/agent/loop'
import { NoToolExecutorLayer } from './no-tool-executor-layer'
import { OpenAiProviderLayer } from '@yolk-sdk/agent/providers/openai/provider'
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
  makeAgentLoopLayer({
    provider: providerLayer,
    tools: toolExecutorLayer,
    transformer: AgentContextTransformerLayer,
    config: LoopConfig.defaultLayer
  })

export const makeAgentRuntimeLayer = <E, R>(providerLayer: Layer.Layer<LLMProvider, E, R>) =>
  makeAgentRuntimeLayerWithTools(providerLayer, NoToolExecutorLayer)

export const AgentRuntimeLayer = makeAgentRuntimeLayer(OpenAiProviderLayer)
