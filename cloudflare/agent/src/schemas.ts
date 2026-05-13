import * as Schema from 'effect/Schema'
import { McpRemoteServerConfigsSchema } from '../../../lib/agents/mcp/schema.ts'

export const BootstrapRequest = Schema.Struct({
  userId: Schema.String,
  tokenEndpoint: Schema.String,
  codexResponsesEndpoint: Schema.String,
  bridgeSecret: Schema.String,
  mcpServers: Schema.optional(McpRemoteServerConfigsSchema)
})
export type BootstrapRequest = typeof BootstrapRequest.Type

export const CodexAccessToken = Schema.Struct({
  access: Schema.String,
  expires: Schema.Number,
  accountId: Schema.optional(Schema.String)
})
export type CodexAccessToken = typeof CodexAccessToken.Type
