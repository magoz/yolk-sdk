import { Array as Arr, Effect, Option } from 'effect'
import type { Layer } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import type { HttpClient } from 'effect/unstable/http'
import { ToolError } from '@yolk-sdk/agent/loop'
import {
  callRemoteMcpServerTool,
  listRemoteMcpServerTools,
  sanitizeMcpName
} from '@yolk-sdk/mcp/client'
import type { McpRemoteServerConfig, McpResolvedTool, McpSecurityPolicy } from '@yolk-sdk/mcp/client'
import type { ToolModule, ToolRegistration } from '@yolk-sdk/agent/tools'
import type { AgentToolContext } from './tool-context.ts'

const mcpSecurityPolicy: McpSecurityPolicy = {
  allowLocalServers: false,
  allowDevHttpLocalhost: false
}

const toToolError = (tool: string, message: string) =>
  new ToolError({
    tool,
    message,
    cause: 'execution'
  })

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const emptyMcpResolvedTools: ReadonlyArray<McpResolvedTool> = []

type McpHttpClientLayer = Layer.Layer<HttpClient.HttpClient>

const findServerConfig = (
  configs: ReadonlyArray<McpRemoteServerConfig>,
  serverName: string
): Option.Option<McpRemoteServerConfig> =>
  Arr.findFirst(configs, config => config.name === serverName)

const makeRegistration = (
  configs: ReadonlyArray<McpRemoteServerConfig>,
  resolved: McpResolvedTool,
  httpClientLayer: McpHttpClientLayer
): ToolRegistration<AgentToolContext> => ({
  def: resolved.def,
  access: 'read',
  isEnabled: context => Effect.succeed(context.surface === 'text'),
  execute: ({ call }) =>
    Effect.gen(function* () {
      const configOption = findServerConfig(configs, resolved.serverName)
      if (Option.isNone(configOption)) {
        return yield* Effect.fail(
          toToolError(call.name, `MCP server is not configured: ${resolved.serverName}`)
        )
      }

      return yield* callRemoteMcpServerTool({
        config: configOption.value,
        mcpToolName: resolved.mcpToolName,
        toolCallId: call.id,
        params: call.params,
        options: { securityPolicy: mcpSecurityPolicy }
      }).pipe(
        Effect.provide(httpClientLayer),
        Effect.mapError(error => toToolError(call.name, error.message))
      )
    })
})

export const makeMcpToolModule = (
  allConfigs: ReadonlyArray<McpRemoteServerConfig>,
  httpClientLayer: McpHttpClientLayer = FetchHttpClient.layer
): Effect.Effect<ToolModule<AgentToolContext>, never, never> =>
  Effect.gen(function* () {
    const configs = allConfigs
    const resolvedByServer = yield* Effect.forEach(configs, config =>
      listRemoteMcpServerTools(config, { securityPolicy: mcpSecurityPolicy }).pipe(
        Effect.provide(httpClientLayer),
        Effect.catch(error =>
          Effect.logWarning('MCP server unavailable', {
            server: config.name,
            error: unknownToMessage(error)
          }).pipe(Effect.as(emptyMcpResolvedTools))
        )
      )
    )
    const tools = Arr.flatten(resolvedByServer).map(tool =>
      makeRegistration(configs, tool, httpClientLayer)
    )

    return {
      id: `mcp-${sanitizeMcpName('configured')}`,
      tools
    }
  })
