import * as Schema from 'effect/Schema'
import { TokenBrokerResponse } from '@yolk/oauth'
import { McpRemoteServerConfigsSchema } from '../../../lib/agents/mcp/schema.ts'

export const BootstrapRequest = Schema.Struct({
  userId: Schema.String,
  tokenEndpoint: Schema.String,
  codexResponsesEndpoint: Schema.optional(Schema.String),
  bridgeSecret: Schema.String,
  mcpServers: Schema.optional(McpRemoteServerConfigsSchema)
})
export type BootstrapRequest = typeof BootstrapRequest.Type

export const CodexAccessToken = TokenBrokerResponse
export type CodexAccessToken = typeof CodexAccessToken.Type
