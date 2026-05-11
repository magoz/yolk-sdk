import { Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolCall, contentText, type ToolDef, type ToolResult } from '@yolk/protocol'
import { latestMcpProtocolVersion } from '@yolk/mcp'
import { McpServerError } from './errors'

type JsonRpcRequest = {
  readonly jsonrpc: '2.0'
  readonly id: string | number
  readonly method: string
  readonly params?: unknown
}

type JsonRpcNotification = {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly params?: unknown
}

type JsonRpcResponse = {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly result?: unknown
  readonly error?: {
    readonly code: number
    readonly message: string
  }
}

const JsonRpcRequestSchema = Schema.Struct({
  jsonrpc: Schema.Literal('2.0'),
  id: Schema.Union([Schema.String, Schema.Number]),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown)
})

const JsonRpcNotificationSchema = Schema.Struct({
  jsonrpc: Schema.Literal('2.0'),
  method: Schema.String,
  params: Schema.optional(Schema.Unknown)
})

const CallToolParamsSchema = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optional(Schema.Unknown)
})

const JsonRpcMessageSchema = Schema.Union([JsonRpcRequestSchema, JsonRpcNotificationSchema])

const decodeJsonRpcMessageFromJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(JsonRpcMessageSchema)
)

const decodeCallToolParams = Schema.decodeUnknownEffect(CallToolParamsSchema)

const encodeJson = (value: unknown) =>
  Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(value).pipe(
    Effect.mapError(
      error =>
        new McpServerError({
          message: `Could not encode MCP response: ${String(error)}`,
          cause: 'validation'
        })
    )
  )

const decodeMessage = (line: string) =>
  decodeJsonRpcMessageFromJson(line).pipe(
    Effect.mapError(
      error =>
        new McpServerError({
          message: `Invalid MCP JSON-RPC message: ${String(error)}`,
          cause: 'validation'
        })
    )
  )

const successResponse = (id: string | number, result: unknown): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  result
})

const errorResponse = (
  id: string | number | null,
  code: number,
  message: string
): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message }
})

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const isRequest = (message: JsonRpcRequest | JsonRpcNotification): message is JsonRpcRequest =>
  'id' in message

const mcpResultFromToolResult = (result: ToolResult) => ({
  content: [{ type: 'text', text: contentText(result.content) }]
})

const toolListItem = (tool: ToolDef) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.parameters
})

export type McpServerTool<R = never> = {
  readonly def: ToolDef
  readonly execute: (call: ToolCall) => Effect.Effect<ToolResult, McpServerError, R>
}

export type McpToolServer<R = never> = {
  readonly handleLine: (line: string) => Effect.Effect<Option.Option<string>, McpServerError, R>
}

export const makeMcpToolServer = <R>(input: {
  readonly name: string
  readonly version: string
  readonly tools: ReadonlyArray<McpServerTool<R>>
}): McpToolServer<R> => {
  const findTool = (name: string) => input.tools.find(tool => tool.def.name === name)

  const handleRequest = (request: JsonRpcRequest) =>
    Effect.gen(function* () {
      switch (request.method) {
        case 'initialize':
          return successResponse(request.id, {
            protocolVersion: latestMcpProtocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: input.name, version: input.version }
          })
        case 'tools/list':
          return successResponse(request.id, {
            tools: input.tools.map(tool => toolListItem(tool.def))
          })
        case 'tools/call': {
          const params = yield* decodeCallToolParams(request.params).pipe(
            Effect.mapError(
              error =>
                new McpServerError({
                  message: `Invalid tools/call params: ${String(error)}`,
                  cause: 'validation'
                })
            )
          )
          const tool = findTool(params.name)
          if (tool === undefined) {
            return errorResponse(request.id, -32_602, `Unknown tool: ${params.name}`)
          }

          const result = yield* tool
            .execute(
              ToolCall.make({
                id: String(request.id),
                name: params.name,
                params: params.arguments ?? {}
              })
            )
            .pipe(
              Effect.catch(error =>
                Effect.fail(
                  new McpServerError({
                    message: `MCP tool failed: ${error.message}`,
                    cause: 'tool_error'
                  })
                )
              )
            )

          return successResponse(request.id, mcpResultFromToolResult(result))
        }
        default:
          return errorResponse(request.id, -32_601, `Method not found: ${request.method}`)
      }
    }).pipe(
      Effect.catch(error =>
        Effect.succeed(errorResponse(request.id, -32_000, unknownToMessage(error)))
      )
    )

  const handleLine = (line: string) =>
    Effect.gen(function* () {
      const message = yield* decodeMessage(line)
      if (!isRequest(message)) {
        return Option.none<string>()
      }

      const response = yield* handleRequest(message)
      const encoded = yield* encodeJson(response)
      return Option.some(encoded)
    })

  return { handleLine }
}
