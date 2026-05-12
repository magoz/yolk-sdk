import * as Schema from 'effect/Schema'

export class McpServerError extends Schema.TaggedErrorClass<McpServerError>()('McpServerError', {
  message: Schema.String,
  cause: Schema.Literals(['parse', 'validation', 'protocol', 'tool_error', 'encoding'])
}) {}
