import { Layer } from 'effect'
import { ContextTransformer, LoopConfig, type LLMProvider } from '@yolk/agent-loop'
import { NoToolExecutorLayer } from './no-tool-executor-layer'
import { OpenAiProviderLayer } from './providers/openai-provider'
import { StatelessSessionStoreLayer } from './stateless-session-store-layer'

export const makeAgentRuntimeLayer = <E, R>(providerLayer: Layer.Layer<LLMProvider, E, R>) =>
  Layer.mergeAll(
    ContextTransformer.identity,
    LoopConfig.defaultLayer,
    providerLayer,
    NoToolExecutorLayer,
    StatelessSessionStoreLayer
  )

export const AgentRuntimeLayer = makeAgentRuntimeLayer(OpenAiProviderLayer)
