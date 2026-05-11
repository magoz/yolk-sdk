import { Array as Arr, Effect, Option } from 'effect'
import { ToolError } from '@yolk/agent-loop'
import { callMcpServerTool, listMcpServerTools, sanitizeMcpName } from '@yolk/mcp'
import type { McpResolvedTool, McpServerConfig } from '@yolk/mcp'
import type { ToolModule, ToolRegistration } from '@yolk/tool-registry'
import type { AgentToolContext } from './tool-context'
import { loadMcpSecurityPolicy, loadMcpServerConfigs } from './mcp-config'

const toToolError = (tool: string, message: string) =>
  new ToolError({
    tool,
    message,
    cause: 'execution'
  })

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const emptyMcpConfigs: ReadonlyArray<McpServerConfig> = []
const emptyMcpResolvedTools: ReadonlyArray<McpResolvedTool> = []

const findServerConfig = (
  configs: ReadonlyArray<McpServerConfig>,
  serverName: string
): Option.Option<McpServerConfig> => Arr.findFirst(configs, config => config.name === serverName)

const makeRegistration = (
  configs: ReadonlyArray<McpServerConfig>,
  resolved: McpResolvedTool
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

      const policy = yield* loadMcpSecurityPolicy()
      return yield* callMcpServerTool({
        config: configOption.value,
        mcpToolName: resolved.mcpToolName,
        toolCallId: call.id,
        params: call.params,
        options: { securityPolicy: policy }
      }).pipe(Effect.mapError(error => toToolError(call.name, error.message)))
    })
})

export const makeMcpToolModule = (): Effect.Effect<ToolModule<AgentToolContext>, never, never> =>
  Effect.gen(function* () {
    const configs = yield* loadMcpServerConfigs().pipe(
      Effect.catch(error =>
        Effect.logWarning('Invalid MCP config', { error: unknownToMessage(error) }).pipe(
          Effect.as(emptyMcpConfigs)
        )
      )
    )
    const policy = yield* loadMcpSecurityPolicy()
    const resolvedByServer = yield* Effect.forEach(configs, config =>
      listMcpServerTools(config, { securityPolicy: policy }).pipe(
        Effect.catch(error =>
          Effect.logWarning('MCP server unavailable', {
            server: config.name,
            error: unknownToMessage(error)
          }).pipe(Effect.as(emptyMcpResolvedTools))
        )
      )
    )
    const tools = Arr.flatten(resolvedByServer).map(tool => makeRegistration(configs, tool))

    return {
      id: `mcp-${sanitizeMcpName('configured')}`,
      tools
    }
  })
