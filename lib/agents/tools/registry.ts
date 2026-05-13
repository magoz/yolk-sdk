import { Effect } from 'effect'
import { webFetchWorkerToolModule as webFetchToolModule } from './web-fetch-worker-tool'
import { webSearchToolModule } from './web-search-tool'
import { skillToolModule } from './skill-tool'
import { makeMcpToolModule } from './mcp-tool-module'
import { resolveAgentToolSet } from './resolve-toolset'
import type { McpRemoteServerConfig } from '@yolk/mcp-client'
import type { AgentToolContext } from './tool-context'

export { resolveAgentToolSet } from './resolve-toolset'

export const nodeTextToolModules = [webFetchToolModule, webSearchToolModule, skillToolModule]
export const nodeVoiceToolModules = [webFetchToolModule, webSearchToolModule]

export const makeTextToolModules = (mcpServers: ReadonlyArray<McpRemoteServerConfig>) =>
  Effect.gen(function* () {
    const mcpToolModule = yield* makeMcpToolModule(mcpServers)

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
