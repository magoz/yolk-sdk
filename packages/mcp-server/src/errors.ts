import * as Schema from 'effect/Schema'

export class McpServerError extends Schema.TaggedErrorClass<McpServerError>()('McpServerError', {
  message: Schema.String,
  cause: Schema.Literals(['validation', 'protocol', 'tool_error'])
}) {}
