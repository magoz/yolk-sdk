import type { Layer } from 'effect'
import type { HttpClient } from 'effect/unstable/http'
import type { McpRemoteServerConfig } from '@yolk/mcp-client'
import { makeTextToolModules } from '../../../lib/agents/tools/registry.ts'

export const makeCloudflareTextToolModules = (
  mcpServers: ReadonlyArray<McpRemoteServerConfig>,
  httpClientLayer?: Layer.Layer<HttpClient.HttpClient>
) => makeTextToolModules(mcpServers, httpClientLayer)
