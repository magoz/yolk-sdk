import { addAgentUsage, type AgentUsage, type ToolResult } from '@yolk-sdk/agent/protocol'
import { subagentUsageFromToolResult } from '@yolk-sdk/agent/tools'

export const addWorkflowToolResultUsage = (usage: AgentUsage, result: ToolResult): AgentUsage => {
  const nestedUsage = subagentUsageFromToolResult(result)

  return nestedUsage === undefined ? usage : addAgentUsage(usage, nestedUsage)
}
