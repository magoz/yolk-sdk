export * from '@modelcontextprotocol/server'

export {
  approvalInputKey,
  changedPromptMessage,
  declaresFormElicitation,
  mcpServerMaxPromptBytes,
  oversizedPromptMessage,
  staleApprovalMessage
} from './approval.ts'

export type {
  McpServerApprovalOptions,
  McpServerElicitation,
  McpServerToolAnswered,
  McpServerToolApprovalPolicy,
  McpServerToolApproved
} from './approval.ts'

export { mcpFormBoolean, mcpFormChoice, mcpFormMultiSelect, mcpServerForm } from './form.ts'

export type {
  McpServerForm,
  McpServerFormField,
  McpServerFormFieldOf,
  McpServerFormOption
} from './form.ts'

export { McpServerError } from './errors.ts'

export { makeMcpServerElicitedTool, makeMcpToolServer } from './server.ts'

export type {
  McpServerApprovalTool,
  McpServerDirectTool,
  McpServerElicitedTool,
  McpServerTool,
  McpServerToolAnnotations,
  McpToolServer
} from './server.ts'

export { runStdioMcpServer } from './stdio.ts'
