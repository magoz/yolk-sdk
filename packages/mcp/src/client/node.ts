export * from '@modelcontextprotocol/client/stdio'

import { Effect } from 'effect'
// The module itself, not the package root: the root evaluates every Node platform module (HTTP,
// sockets, Redis, workers), megabytes this subpath never uses.
import * as NodeServices from '@effect/platform-node/NodeServices'
import type { McpLocalServerConfig, McpServerConfig } from './config.ts'
import {
  callLocalMcpServerTool,
  callMcpServerTool,
  listLocalMcpServerTools,
  listMcpServerTools,
  listMcpTools,
  type CallMcpServerToolInput,
  type McpClientOptions
} from './client.ts'

export const listLocalMcpServerToolsNode = (
  config: McpLocalServerConfig,
  options?: McpClientOptions
) => listLocalMcpServerTools(config, options).pipe(Effect.provide(NodeServices.layer))

export const listMcpServerToolsNode = (config: McpServerConfig, options?: McpClientOptions) =>
  listMcpServerTools(config, options).pipe(Effect.provide(NodeServices.layer))

export const listMcpToolsNode = (
  configs: ReadonlyArray<McpServerConfig>,
  options?: McpClientOptions
) => listMcpTools(configs, options).pipe(Effect.provide(NodeServices.layer))

export const callLocalMcpServerToolNode = (
  input: Omit<CallMcpServerToolInput, 'config'> & { readonly config: McpLocalServerConfig }
) => callLocalMcpServerTool(input).pipe(Effect.provide(NodeServices.layer))

export const callMcpServerToolNode = (input: CallMcpServerToolInput) =>
  callMcpServerTool(input).pipe(Effect.provide(NodeServices.layer))
