import { resolveTools } from '@yolk/tool-registry'
import type { AgentToolContext } from './tool-context'
import { webFetchToolModule } from './web-fetch-tool'
import { webSearchToolModule } from './web-search-tool'

const agentToolModules = [webFetchToolModule, webSearchToolModule]

export const resolveAgentTools = (context: AgentToolContext) =>
  resolveTools(agentToolModules, context)
