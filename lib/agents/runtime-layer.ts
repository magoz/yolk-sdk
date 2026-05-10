import { Layer } from 'effect'
import { ContextTransformer, LoopConfig, type LLMProvider, type ToolExecutor } from '@yolk/agent-loop'
import { NoToolExecutorLayer } from './no-tool-executor-layer'
import { OpenAiProviderLayer } from './providers/openai-provider'
import { StatelessSessionStoreLayer } from './stateless-session-store-layer'

export const makeAgentRuntimeLayerWithTools = <ProviderError, ProviderRequirements, ToolError, ToolRequirements>(
  providerLayer: Layer.Layer<LLMProvider, ProviderError, ProviderRequirements>,
  toolExecutorLayer: Layer.Layer<ToolExecutor, ToolError, ToolRequirements>
) =>
  Layer.mergeAll(
    ContextTransformer.identity,
    LoopConfig.defaultLayer,
    providerLayer,
    toolExecutorLayer,
    StatelessSessionStoreLayer
  )

export const makeAgentRuntimeLayer = <E, R>(providerLayer: Layer.Layer<LLMProvider, E, R>) =>
  makeAgentRuntimeLayerWithTools(providerLayer, NoToolExecutorLayer)

export const AgentRuntimeLayer = makeAgentRuntimeLayer(OpenAiProviderLayer)
