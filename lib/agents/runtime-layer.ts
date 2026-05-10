import { Layer } from 'effect'
import { ContextTransformer, LoopConfig } from '@yolk/agent-loop'
import { NoToolExecutorLayer } from './no-tool-executor-layer'
import { AnthropicProviderLayer } from './providers/anthropic-provider'
import { VolatileSessionStoreLayer } from './volatile-session-store-layer'

export const AgentRuntimeLayer = Layer.mergeAll(
  ContextTransformer.identity,
  LoopConfig.defaultLayer,
  AnthropicProviderLayer,
  NoToolExecutorLayer,
  VolatileSessionStoreLayer
)
