import { Array as Arr, Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'
import {
  ToolCall,
  contentParts,
  type ContentPart,
  type ToolDef,
  type ToolResult
} from '@yolk/agent/protocol'
import { latestMcpProtocolVersion } from '@yolk/mcp/client'
import { McpServerError } from './errors.ts'

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

type JsonRpcMessage = typeof JsonRpcMessageSchema.Type

type DecodedLine =
  | { readonly _tag: 'Message'; readonly message: JsonRpcMessage }
  | { readonly _tag: 'Response'; readonly response: Option.Option<string> }

const decodedMessage = (message: JsonRpcMessage): DecodedLine => ({ _tag: 'Message', message })

const decodedResponse = (response: Option.Option<string>): DecodedLine => ({
  _tag: 'Response',
  response
})

const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)
const decodeJsonRpcMessage = Schema.decodeUnknownEffect(JsonRpcMessageSchema)
const decodeCallToolParams = Schema.decodeUnknownEffect(CallToolParamsSchema)

const encodeJson = (value: unknown) =>
  Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(value).pipe(
    Effect.mapError(
      error =>
        new McpServerError({
          message: `Could not encode MCP response: ${String(error)}`,
          cause: 'encoding'
        })
    )
  )

const decodeMessage = (line: string) =>
  decodeJson(line).pipe(
    Effect.mapError(
      error =>
        new McpServerError({
          message: `Malformed MCP JSON: ${String(error)}`,
          cause: 'parse'
        })
    ),
    Effect.flatMap(value =>
      decodeJsonRpcMessage(value).pipe(
        Effect.mapError(
          error =>
            new McpServerError({
              message: `Invalid MCP JSON-RPC message: ${String(error)}`,
              cause: 'validation'
            })
        )
      )
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

const protocolErrorCode = (error: McpServerError) => {
  switch (error.cause) {
    case 'parse':
      return -32_700
    case 'validation':
      return -32_600
    case 'protocol':
      return -32_603
    case 'tool_error':
    case 'encoding':
      return -32_000
  }
}

const protocolErrorResponse = (id: string | number | null, error: McpServerError) =>
  errorResponse(id, protocolErrorCode(error), error.message)

const mcpContentBlockFromPart = (part: ContentPart) => {
  switch (part._tag) {
    case 'Text':
      return { type: 'text', text: part.text }
    case 'Image':
      return { type: 'image', data: part.data, mimeType: part.mimeType }
    case 'Audio':
      return { type: 'audio', data: part.data, mimeType: `audio/${part.format}` }
  }
}

const mcpResultFromToolResult = (result: ToolResult) => {
  const content = Arr.map(contentParts(result.content), mcpContentBlockFromPart)
  const base = result.isError === undefined ? { content } : { content, isError: result.isError }

  return result.structuredContent === undefined
    ? base
    : { ...base, structuredContent: result.structuredContent }
}

const mcpErrorResult = (message: string) => ({
  content: [{ type: 'text', text: message }],
  isError: true
})

const mcpResultFromExecutionResult = (result: ToolResult | ReturnType<typeof mcpErrorResult>) =>
  'toolCallId' in result ? mcpResultFromToolResult(result) : result

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
  readonly handleJson: (body: string) => Effect.Effect<string, McpServerError, R>
  readonly handleHttpRequest: (request: Request) => Effect.Effect<Response, never, R>
}

const jsonResponse = (body: string, init?: ResponseInit) =>
  new Response(body, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {})
    }
  })

const methodNotAllowedBody = () =>
  encodeJson(errorResponse(null, -32_600, 'Method not allowed')).pipe(
    Effect.orElseSucceed(
      () => '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Method not allowed"}}'
    )
  )

const badRequestBody = (message: string) =>
  encodeJson(errorResponse(null, -32_600, message)).pipe(
    Effect.orElseSucceed(
      () => '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Bad request"}}'
    )
  )

export const makeMcpToolServer = <R>(input: {
  readonly name: string
  readonly version: string
  readonly tools: ReadonlyArray<McpServerTool<R>>
}): McpToolServer<R> => {
  const findTool = (name: string) => Arr.findFirst(input.tools, tool => tool.def.name === name)

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
          if (Option.isNone(tool)) {
            return errorResponse(request.id, -32_602, `Unknown tool: ${params.name}`)
          }

          const result = yield* tool.value
            .execute(
              ToolCall.make({
                id: String(request.id),
                name: params.name,
                params: params.arguments ?? {}
              })
            )
            .pipe(
              Effect.catch(error =>
                Effect.succeed(mcpErrorResult(`MCP tool failed: ${error.message}`))
              )
            )

          return successResponse(request.id, mcpResultFromExecutionResult(result))
        }
        default:
          return errorResponse(request.id, -32_601, `Method not found: ${request.method}`)
      }
    }).pipe(
      Effect.catch(error =>
        error instanceof McpServerError
          ? Effect.succeed(protocolErrorResponse(request.id, error))
          : Effect.succeed(errorResponse(request.id, -32_000, unknownToMessage(error)))
      )
    )

  const handleLine = (line: string) =>
    Effect.gen(function* () {
      const decoded: DecodedLine = yield* decodeMessage(line).pipe(
        Effect.map(decodedMessage),
        Effect.catch(error =>
          encodeJson(protocolErrorResponse(null, error)).pipe(
            Effect.map(response => decodedResponse(Option.some(response)))
          )
        )
      )

      if (decoded._tag === 'Response') {
        return decoded.response
      }

      const { message } = decoded

      if (!isRequest(message)) {
        return Option.none<string>()
      }

      const response = yield* handleRequest(message)
      const encoded = yield* encodeJson(response)
      return Option.some(encoded)
    })

  const handleJson = (body: string) =>
    Effect.gen(function* () {
      const response = yield* handleLine(body)
      if (Option.isNone(response)) {
        return yield* encodeJson(errorResponse(null, -32_600, 'Notifications have no response'))
      }

      return response.value
    })

  const handleHttpRequest = (request: Request) =>
    Effect.gen(function* () {
      if (request.method !== 'POST') {
        const body = yield* methodNotAllowedBody()
        return jsonResponse(body, { status: 405, headers: { allow: 'POST' } })
      }

      const body = yield* Effect.promise(() => request.text()).pipe(
        Effect.mapError(error => unknownToMessage(error)),
        Effect.catch(error => badRequestBody(`Could not read request body: ${error}`))
      )

      const responseBody = yield* handleJson(body).pipe(
        Effect.catch(error => badRequestBody(unknownToMessage(error)))
      )

      return jsonResponse(responseBody)
    })

  return { handleLine, handleJson, handleHttpRequest }
}
