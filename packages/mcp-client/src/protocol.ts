import { Array as Arr, Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolDef, ToolResult } from '@yolk/protocol'
import { McpError } from './errors.ts'

export const latestMcpProtocolVersion = '2024-11-05'

export const JsonRpcErrorObject = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optional(Schema.Unknown)
})
export type JsonRpcErrorObject = typeof JsonRpcErrorObject.Type

export const JsonRpcSuccessResponse = Schema.Struct({
  jsonrpc: Schema.Literal('2.0'),
  id: Schema.Union([Schema.String, Schema.Number, Schema.Null]),
  result: Schema.Unknown
})
export type JsonRpcSuccessResponse = typeof JsonRpcSuccessResponse.Type

export const JsonRpcErrorResponse = Schema.Struct({
  jsonrpc: Schema.Literal('2.0'),
  id: Schema.Union([Schema.String, Schema.Number, Schema.Null]),
  error: JsonRpcErrorObject
})
export type JsonRpcErrorResponse = typeof JsonRpcErrorResponse.Type

export const JsonRpcResponse = Schema.Union([JsonRpcSuccessResponse, JsonRpcErrorResponse])
export type JsonRpcResponse = typeof JsonRpcResponse.Type

export const JsonRpcRequest = Schema.Struct({
  jsonrpc: Schema.Literal('2.0'),
  id: Schema.Union([Schema.String, Schema.Number]),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown)
})
export type JsonRpcRequest = typeof JsonRpcRequest.Type

export const JsonRpcNotification = Schema.Struct({
  jsonrpc: Schema.Literal('2.0'),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown)
})
export type JsonRpcNotification = typeof JsonRpcNotification.Type

export const JsonRpcMessage = Schema.Union([JsonRpcRequest, JsonRpcNotification])
export type JsonRpcMessage = typeof JsonRpcMessage.Type

export const McpTool = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  inputSchema: Schema.optional(Schema.Unknown)
})
export type McpTool = typeof McpTool.Type

export const ToolsListResult = Schema.Struct({
  tools: Schema.Array(McpTool)
})
export type ToolsListResult = typeof ToolsListResult.Type

export const TextContentBlock = Schema.Struct({
  type: Schema.Literal('text'),
  text: Schema.String
})
export type TextContentBlock = typeof TextContentBlock.Type

export const GenericContentBlock = Schema.Record(Schema.String, Schema.Unknown)
export type GenericContentBlock = typeof GenericContentBlock.Type

export const ToolCallResult = Schema.Struct({
  content: Schema.optional(Schema.Array(GenericContentBlock)),
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown)
})
export type ToolCallResult = typeof ToolCallResult.Type

export const makeJsonRpcRequest = (input: {
  readonly id: string | number
  readonly method: string
  readonly params?: unknown
}): JsonRpcRequest => ({
  jsonrpc: '2.0',
  id: input.id,
  method: input.method,
  ...(input.params === undefined ? {} : { params: input.params })
})

export const makeInitializedNotification = (): JsonRpcNotification => ({
  jsonrpc: '2.0',
  method: 'notifications/initialized'
})

export const makeInitializeParams = (input: {
  readonly name: string
  readonly version: string
}) => ({
  protocolVersion: latestMcpProtocolVersion,
  capabilities: {},
  clientInfo: {
    name: input.name,
    version: input.version
  }
})

export const jsonRpcErrorToMcpError = (server: string, error: JsonRpcErrorObject) =>
  new McpError({
    server,
    message: `MCP JSON-RPC error ${error.code}: ${error.message}`,
    cause: 'protocol'
  })

export const mcpToolToToolDef = (input: { readonly serverName: string; readonly tool: McpTool }) =>
  ToolDef.make({
    name: `${sanitizeMcpName(input.serverName)}_${sanitizeMcpName(input.tool.name)}`,
    description: input.tool.description ?? `MCP tool ${input.serverName}/${input.tool.name}`,
    parameters: input.tool.inputSchema ?? { type: 'object', additionalProperties: true }
  })

export const sanitizeMcpName = (name: string) => {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  return sanitized.length === 0 ? 'mcp' : sanitized
}

const contentBlockText = (block: GenericContentBlock): Option.Option<string> => {
  const type = block['type']
  const text = block['text']

  if (type === 'text' && typeof text === 'string') {
    return Option.some(text)
  }

  return Option.none()
}

export const toolCallResultToToolResult = (input: {
  readonly toolCallId: string
  readonly result: ToolCallResult
}) => {
  const content = input.result.content ?? []
  const textBlocks = Arr.getSomes(Arr.map(content, contentBlockText))
  const text = textBlocks.length > 0 ? textBlocks.join('\n') : 'Unsupported MCP tool content.'

  return ToolResult.make({
    toolCallId: input.toolCallId,
    content: text
  })
}

export const decodeJsonRpcResponse = Schema.decodeUnknownEffect(JsonRpcResponse)
export const decodeToolsListResult = Schema.decodeUnknownEffect(ToolsListResult)
export const decodeToolCallResult = Schema.decodeUnknownEffect(ToolCallResult)

export const encodeJsonRpcMessage = (
  server: string,
  message: JsonRpcRequest | JsonRpcNotification
) =>
  Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(message).pipe(
    Effect.mapError(
      error =>
        new McpError({
          server,
          message: `Could not encode MCP JSON-RPC message: ${String(error)}`,
          cause: 'encoding'
        })
    )
  )

const decodeJsonString = (server: string, text: string) =>
  Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(text).pipe(
    Effect.mapError(
      error =>
        new McpError({
          server,
          message: `Malformed MCP JSON: ${String(error)}`,
          cause: 'parse'
        })
    )
  )

export const decodeJsonRpcResponseFromJson = (server: string, text: string) =>
  decodeJsonString(server, text).pipe(
    Effect.flatMap(decodeJsonRpcResponse),
    Effect.mapError(
      error =>
        error instanceof McpError
          ? error
          : new McpError({
              server,
              message: `Invalid MCP JSON-RPC response: ${String(error)}`,
              cause: 'validation'
            })
    )
  )

export const decodeJsonRpcMessageFromJson = (server: string, text: string) =>
  decodeJsonString(server, text).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(JsonRpcMessage)),
    Effect.mapError(error =>
      error instanceof McpError
        ? error
        : new McpError({
            server,
            message: `Invalid MCP JSON-RPC message: ${String(error)}`,
            cause: 'validation'
          })
    )
  )
