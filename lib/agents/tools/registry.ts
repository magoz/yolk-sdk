import { Effect } from 'effect'
import type { Layer } from 'effect'
import type { HttpClient } from 'effect/unstable/http'
import { webFetchWorkerToolModule as webFetchToolModule } from './web-fetch-worker-tool.ts'
import { webSearchToolModule } from './web-search-tool.ts'
import { skillToolModule } from './skill-tool.ts'
import { makeMcpToolModule } from './mcp-tool-module.ts'
import { resolveAgentToolSet } from './resolve-toolset.ts'
import type { McpRemoteServerConfig } from '@yolk/mcp-client'
import type { AgentToolContext } from './tool-context.ts'

export { resolveAgentToolSet } from './resolve-toolset.ts'

export const nodeTextToolModules = [webFetchToolModule, webSearchToolModule, skillToolModule]
export const nodeVoiceToolModules = [webFetchToolModule, webSearchToolModule]

export const makeTextToolModules = (
  mcpServers: ReadonlyArray<McpRemoteServerConfig>,
  httpClientLayer?: Layer.Layer<HttpClient.HttpClient>
) =>
  Effect.gen(function* () {
    const mcpToolModule = yield* makeMcpToolModule(mcpServers, httpClientLayer)

    return mcpToolModule.tools.length === 0
      ? nodeTextToolModules
      : [...nodeTextToolModules, mcpToolModule]
  })

export const makeNodeTextToolModules = () => makeTextToolModules([])

export const makeNodeVoiceToolModules = () => Effect.succeed(nodeVoiceToolModules)

export const resolveNodeTextTools = (context: AgentToolContext) =>
  Effect.gen(function* () {
    const modules = yield* makeNodeTextToolModules()

    return yield* resolveAgentToolSet({ modules, context })
  })

export const resolveNodeVoiceTools = (context: AgentToolContext) =>
  resolveAgentToolSet({ modules: nodeVoiceToolModules, context })

export const resolveAgentTools = resolveNodeTextTools
