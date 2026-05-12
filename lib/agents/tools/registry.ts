import { Effect } from 'effect'
import { resolveTools } from '@yolk/tool-registry'
import type { AgentToolContext } from './tool-context'
import { webFetchToolModule } from './web-fetch-tool'
import { webSearchToolModule } from './web-search-tool'
import { skillToolModule } from './skill-tool'
import { makeMcpToolModule } from './mcp-tool-module'

const staticAgentToolModules = [webFetchToolModule, webSearchToolModule, skillToolModule]

export const resolveAgentTools = (context: AgentToolContext) =>
  Effect.gen(function* () {
    const mcpToolModule = yield* makeMcpToolModule()

    return yield* resolveTools(
      mcpToolModule.tools.length === 0
        ? staticAgentToolModules
        : [...staticAgentToolModules, mcpToolModule],
      context
    )
  })
