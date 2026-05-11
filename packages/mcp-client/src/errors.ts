import * as Schema from 'effect/Schema'

export const McpErrorCause = Schema.Literals([
  'disabled',
  'security',
  'transport',
  'protocol',
  'timeout',
  'validation',
  'tool_error'
])
export type McpErrorCause = typeof McpErrorCause.Type

export class McpError extends Schema.TaggedErrorClass<McpError>()('McpError', {
  server: Schema.String,
  message: Schema.String,
  cause: McpErrorCause
}) {}
