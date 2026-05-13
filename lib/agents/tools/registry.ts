import { Effect } from 'effect'
import { webFetchToolModule } from './web-fetch-tool'
import { webSearchToolModule } from './web-search-tool'
import { skillToolModule } from './skill-tool'
import { makeMcpToolModule } from './mcp-tool-module'
import { resolveAgentToolSet } from './resolve-toolset'
import type { AgentToolContext } from './tool-context'

export { resolveAgentToolSet } from './resolve-toolset'

export const nodeTextToolModules = [webFetchToolModule, webSearchToolModule, skillToolModule]
export const nodeVoiceToolModules = [webFetchToolModule, webSearchToolModule]

export const makeNodeTextToolModules = () =>
  Effect.gen(function* () {
    const mcpToolModule = yield* makeMcpToolModule()

    return mcpToolModule.tools.length === 0
      ? nodeTextToolModules
      : [...nodeTextToolModules, mcpToolModule]
  })

export const makeNodeVoiceToolModules = () => Effect.succeed(nodeVoiceToolModules)

export const resolveNodeTextTools = (context: AgentToolContext) =>
  Effect.gen(function* () {
    const modules = yield* makeNodeTextToolModules()

    return yield* resolveAgentToolSet({ modules, context })
  })

export const resolveNodeVoiceTools = (context: AgentToolContext) =>
  resolveAgentToolSet({ modules: nodeVoiceToolModules, context })

export const resolveAgentTools = resolveNodeTextTools
