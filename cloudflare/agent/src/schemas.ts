import * as Schema from 'effect/Schema'
import { TokenBrokerResponse } from '@yolk-sdk/agent/oauth'
import { SkillsetManifest } from '@yolk-sdk/agent/skillset'
import { McpRemoteServerConfigsSchema } from '../../../examples/next/lib/agents/mcp/schema.ts'

export const BootstrapRequest = Schema.Struct({
  userId: Schema.String,
  tokenEndpoint: Schema.String,
  codexResponsesEndpoint: Schema.optional(Schema.String),
  bridgeSecret: Schema.String,
  mcpServers: Schema.optional(McpRemoteServerConfigsSchema),
  skillset: Schema.optional(SkillsetManifest)
})
export type BootstrapRequest = typeof BootstrapRequest.Type

export const CodexAccessToken = TokenBrokerResponse
export type CodexAccessToken = typeof CodexAccessToken.Type
