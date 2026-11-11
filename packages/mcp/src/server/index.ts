export * from '@modelcontextprotocol/server'

export { approvalInputKey, declaresFormElicitation, staleApprovalMessage } from './approval.ts'

export type {
  McpServerApprovalOptions,
  McpServerToolApprovalPolicy,
  McpServerToolApproved
} from './approval.ts'

export { McpServerError } from './errors.ts'

export { makeMcpToolServer } from './server.ts'

export type {
  McpServerApprovalTool,
  McpServerDirectTool,
  McpServerTool,
  McpServerToolAnnotations,
  McpToolServer
} from './server.ts'

export { runStdioMcpServer } from './stdio.ts'
