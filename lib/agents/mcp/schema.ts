import * as Schema from 'effect/Schema'

export const McpRemoteServerConfigSchema = Schema.Struct({
  name: Schema.String,
  type: Schema.Literal('remote'),
  url: Schema.String,
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  enabled: Schema.optional(Schema.Boolean)
})

export const McpRemoteServerConfigsSchema = Schema.Array(McpRemoteServerConfigSchema)
