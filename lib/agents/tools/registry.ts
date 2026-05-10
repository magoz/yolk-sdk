import { resolveTools } from '@yolk/tool-registry'
import { calculatorToolModule } from './calculator-tool'
import type { AgentToolContext } from './tool-context'

const agentToolModules = [calculatorToolModule]

export const resolveAgentTools = (context: AgentToolContext) =>
  resolveTools(agentToolModules, context)
