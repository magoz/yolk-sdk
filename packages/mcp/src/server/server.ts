import { Array as Arr, Effect, FiberSet, Match, Option, Predicate, Result, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import {
  McpServer as SdkMcpServer,
  createMcpHandler,
  fromJsonSchema,
  isLegacyRequest,
  originValidationResponse,
  type CallToolResult as SdkCallToolResult,
  type ContentBlock as SdkContentBlock,
  type InputRequiredResult,
  type ServerContext
} from '@modelcontextprotocol/server'
import {
  ToolCall,
  ToolResult,
  attachmentSourceBase64,
  attachmentSourcePreview,
  filePartText,
  contentParts,
  type ContentPart,
  type ToolDef
} from '@yolk-sdk/agent/protocol'
import { legacyMcpProtocolVersion } from '@yolk-sdk/mcp/client'
import {
  approvalRound,
  McpApprovalRound,
  makeMcpServerApprovals,
  type McpServerApprovalOptions,
  type McpServerApprovals,
  type McpServerToolApprovalPolicy,
  type McpServerToolApproved
} from './approval.ts'
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

const DecodedMessageLine = Schema.TaggedStruct('Message', {
  message: Schema.Unknown
})

const DecodedResponseLine = Schema.TaggedStruct('Response', {
  response: Schema.Unknown
})

type DecodedLine =
  | {
      readonly _tag: 'Message'
      readonly message: JsonRpcMessage
    }
  | {
      readonly _tag: 'Response'
      readonly response: Option.Option<string>
    }

const decodedMessage = (message: JsonRpcMessage): DecodedLine => ({
  ...DecodedMessageLine.make({ message }),
  message
})

const decodedResponse = (response: Option.Option<string>): DecodedLine => ({
  ...DecodedResponseLine.make({ response }),
  response
})

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

const decodeJsonRpcMessage = Schema.decodeUnknownEffect(JsonRpcMessageSchema)

const decodeCallToolParams = Schema.decodeUnknownEffect(CallToolParamsSchema)

const encodeJson = (value: JsonRpcResponse) =>
  Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(
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

const documentResourceUri = (filename: string) => `file:///${encodeURIComponent(filename)}`

const mcpContentBlockFromPart = (part: ContentPart): SdkContentBlock =>
  Match.value(part).pipe(
    Match.withReturnType<SdkContentBlock>(),
    Match.tag('Text', current => ({ type: 'text', text: current.text })),
    Match.tag('Image', current =>
      Option.match(attachmentSourceBase64(current.source), {
        onNone: () => ({
          type: 'text',
          text: `Image attachment: ${attachmentSourcePreview(current.source)}`
        }),
        onSome: data => ({ type: 'image', data, mimeType: current.mimeType })
      })
    ),
    Match.tag('Document', current =>
      Option.match(attachmentSourceBase64(current.source), {
        onNone: () => ({
          type: 'text',
          text: `Document attachment: ${attachmentSourcePreview(current.source)}`
        }),
        onSome: data => ({
          type: 'resource',
          resource: {
            uri: documentResourceUri(current.filename),
            name: current.title ?? current.filename,
            mimeType: current.mimeType,
            blob: data
          }
        })
      })
    ),
    Match.tag('Audio', current =>
      Option.match(attachmentSourceBase64(current.source), {
        onNone: () => ({
          type: 'text',
          text: `Audio attachment: ${attachmentSourcePreview(current.source)}`
        }),
        onSome: data => ({ type: 'audio', data, mimeType: current.mimeType })
      })
    ),
    // Inline file bytes leave as an embedded resource; a captured file only as its label.
    Match.tag('File', current =>
      Option.match(attachmentSourceBase64(current.source), {
        onNone: () => ({ type: 'text', text: filePartText(current) }),
        onSome: data => ({
          type: 'resource',
          resource: {
            uri: documentResourceUri(current.filename ?? 'file'),
            mimeType: current.mimeType,
            blob: data
          }
        })
      })
    ),
    Match.exhaustive
  )

const mcpResultFromToolResult = (result: ToolResult): SdkCallToolResult => {
  const content = Arr.map(contentParts(result.content), mcpContentBlockFromPart)
  const base = result.isError === undefined ? { content } : { content, isError: result.isError }

  return result.structuredContent === undefined
    ? base
    : { ...base, structuredContent: result.structuredContent }
}

const mcpErrorResult = (message: string): SdkCallToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true
})

/** The MCP tool annotation hints a server lists with a tool (`ToolAnnotations`). */
export type McpServerToolAnnotations = {
  readonly title?: string
  readonly readOnlyHint?: boolean
  readonly destructiveHint?: boolean
  readonly idempotentHint?: boolean
  readonly openWorldHint?: boolean
}

type ToolListItem = {
  readonly name: string
  readonly description: string
  readonly inputSchema: ToolDef['parameters']
  annotations?: McpServerToolAnnotations
}

const toolListItem = <R>(tool: McpServerTool<R>) => {
  const item: ToolListItem = {
    name: tool.def.name,
    description: tool.def.description,
    inputSchema: tool.def.parameters
  }

  if (tool.annotations !== undefined) item.annotations = tool.annotations

  return item
}

type SdkToolConfig = {
  readonly description: string
  readonly inputSchema: ReturnType<typeof fromJsonSchema>
  title?: string
  annotations?: McpServerToolAnnotations
}

const sdkToolConfig = <R>(tool: McpServerTool<R>, schema: Parameters<typeof fromJsonSchema>[0]) => {
  const config: SdkToolConfig = {
    description: tool.def.description,
    inputSchema: fromJsonSchema(schema)
  }

  if (tool.annotations !== undefined) {
    config.annotations = tool.annotations

    if (tool.annotations.title !== undefined) config.title = tool.annotations.title
  }

  return config
}

/** A tool that runs on every call. */
export type McpServerDirectTool<R = never> = {
  readonly def: ToolDef
  readonly annotations?: McpServerToolAnnotations
  readonly approval?: undefined
  readonly execute: (call: ToolCall) => Effect.Effect<ToolResult, McpServerError, R>
}

/**
 * A tool that runs only after the user approves the call through MCP form elicitation
 * (`approval.ts`): offered to `2026-07-28` requests only, when the server has `approvals`.
 * `execute` receives the approval; key once-only execution on its `approvalId`.
 */
export type McpServerApprovalTool<R = never> = {
  readonly def: ToolDef
  readonly annotations?: McpServerToolAnnotations
  readonly approval: McpServerToolApprovalPolicy<R>
  readonly execute: (
    call: ToolCall,
    approved: McpServerToolApproved
  ) => Effect.Effect<ToolResult, McpServerError, R>
}

export type McpServerTool<R = never> = McpServerDirectTool<R> | McpServerApprovalTool<R>

/** Why the header-less JSON path refuses an approval tool: it cannot carry an elicitation. */
const approvalUnavailableResult = () =>
  mcpErrorResult(
    'This tool runs only after the user approves it, which needs an MCP 2026-07-28 client ' +
      'with form elicitation. Nothing ran.'
  )

type ToolCallOutcome = ToolResult | SdkCallToolResult | InputRequiredResult

/** Runs one tool call's Effect as a fiber of the current HTTP request. */
type ToolRunner<R> = (
  effect: Effect.Effect<ToolCallOutcome, never, R>,
  options: Effect.RunOptions
) => Promise<ToolCallOutcome>

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

const internalErrorBody = (error: McpServerError) =>
  encodeJson(protocolErrorResponse(null, error)).pipe(
    Effect.orElseSucceed(
      () => '{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Internal error"}}'
    )
  )

const isEventStream = (response: Response) =>
  response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'text/event-stream'

/**
 * `subscriptions/listen` runs no tool, and its stream ends only when the per-request handler
 * closes, after this returns. The SDK checks `Mcp-Method` against the body only on requests it
 * routes as modern; a legacy one may carry any `Mcp-Method`, so the SDK's own era routing
 * (`isLegacyRequest`, on a body clone) decides. If classifying fails, the stream is read.
 */
const isListenRequest = (request: Request) =>
  request.headers.get('mcp-method') === 'subscriptions/listen'
    ? Effect.tryPromise(() => isLegacyRequest(request)).pipe(
        Effect.map(legacy => !legacy),
        Effect.orElseSucceed(() => false)
      )
    : Effect.succeed(false)

/**
 * The SDK may answer a request with an SSE stream that it fills after returning the `Response`
 * (always for 2025-era requests; for 2026-07-28 once a handler sends a related message). Tools run
 * with the caller's context, whose scope closes as soon as this Effect returns, so the exchange is
 * read to its end here and answered with the same status, headers and events: still a valid
 * request-scoped stream. Interruption cancels the stream, which the SDK treats as cancellation.
 */
const completedExchange = (response: Response, listen: boolean) => {
  const body = response.body

  if (body === null || listen || !isEventStream(response)) {
    return Effect.succeed(response)
  }

  return Stream.fromReadableStream({
    evaluate: () => body,
    onError: error =>
      new McpServerError({
        message: `Could not read MCP response stream: ${unknownToMessage(error)}`,
        cause: 'protocol'
      })
  }).pipe(
    // SSE is always UTF-8 text.
    Stream.decodeText(),
    Stream.mkString,
    Effect.map(
      text =>
        new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        })
    )
  )
}

/** One call of a tool through the SDK: a direct tool runs; an approval tool runs one round. */
const sdkToolCall = <R>(input: {
  readonly tool: McpServerTool<R>
  readonly approvals: McpServerApprovals
  readonly call: ToolCall
  readonly ctx: ServerContext
}): Effect.Effect<ToolCallOutcome, McpServerError, R> => {
  const { tool, call } = input

  if (tool.approval === undefined) return tool.execute(call)

  const execute = tool.execute

  return approvalRound({
    approvals: input.approvals,
    policy: tool.approval,
    call,
    ctx: input.ctx
  }).pipe(
    Effect.flatMap((round): Effect.Effect<ToolCallOutcome, McpServerError, R> =>
      McpApprovalRound.$match(round, {
        Run: ({ approved }) => execute(call, approved),
        Answer: ({ message }) => Effect.succeed(mcpErrorResult(message)),
        Ask: ({ result }) => Effect.succeed(result)
      })
    )
  )
}

/**
 * A Yolk tool set as an MCP server. Approval tools (`McpServerApprovalTool`) are offered only on
 * `2026-07-28` requests and only with `approvals`: the stateless 2025-era serving cannot carry an
 * elicitation (the client's answer would reach another instance), and the header-less JSON path
 * neither lists nor runs them.
 */
export const makeMcpToolServer = <R>(input: {
  readonly name: string
  readonly version: string
  readonly tools: ReadonlyArray<McpServerTool<R>>
  readonly allowedOriginHostnames?: ReadonlyArray<string>
  readonly approvals?: McpServerApprovalOptions
}): McpToolServer<R> => {
  const approvals = makeMcpServerApprovals(input.approvals)

  const offersApprovals = !Predicate.isTagged(approvals, 'Unconfigured')

  const directTools = input.tools.filter(tool => tool.approval === undefined)

  const findTool = (name: string) => Arr.findFirst(input.tools, tool => tool.def.name === name)

  const toolInputSchemas = input.tools.map(tool => ({
    tool,
    schema: Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))(
      tool.def.parameters
    ).pipe(Option.getOrElse(() => ({ type: 'object', additionalProperties: true })))
  }))

  const makeSdkServer = (runTool: ToolRunner<R>, era: 'legacy' | 'modern') => {
    const server = new SdkMcpServer(
      { name: input.name, version: input.version },
      {
        cacheHints: {
          'server/discover': { ttlMs: 0, cacheScope: 'private' },
          'tools/list': { ttlMs: 0, cacheScope: 'private' }
        }
      }
    )

    for (const { schema, tool } of toolInputSchemas) {
      if (tool.approval !== undefined && (era === 'legacy' || !offersApprovals)) continue

      server.registerTool(tool.def.name, sdkToolConfig(tool, schema), async (args, sdkContext) => {
        // The SDK aborts this signal when the client cancels the request (on Streamable HTTP,
        // by closing its response stream), so the tool stops instead of running unobserved.
        const result = await runTool(
          sdkToolCall({
            tool,
            approvals,
            call: ToolCall.make({
              id: String(sdkContext.mcpReq.id),
              name: tool.def.name,
              params: args
            }),
            ctx: sdkContext
          }).pipe(
            Effect.catch(error =>
              Effect.succeed(mcpErrorResult(`MCP tool failed: ${error.message}`))
            )
          ),
          { signal: sdkContext.mcpReq.signal }
        )

        return result instanceof ToolResult ? mcpResultFromToolResult(result) : result
      })
    }

    return server
  }

  const handleRequest = (request: JsonRpcRequest) =>
    Effect.gen(function* () {
      switch (request.method) {
        case 'initialize':
          return successResponse(request.id, {
            protocolVersion: legacyMcpProtocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: input.name, version: input.version }
          })
        case 'tools/list':
          return successResponse(request.id, { tools: directTools.map(toolListItem) })
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

          if (tool.value.approval !== undefined) {
            return successResponse(request.id, approvalUnavailableResult())
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

          return successResponse(
            request.id,
            result instanceof ToolResult ? mcpResultFromToolResult(result) : result
          )
        }

        default:
          return errorResponse(request.id, -32_601, `Method not found: ${request.method}`)
      }
    }).pipe(Effect.catch(error => Effect.succeed(protocolErrorResponse(request.id, error))))

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

      if (Predicate.isTagged(decoded, 'Response')) {
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
      const targetHostname = new URL(request.url).hostname

      const rejected = originValidationResponse(
        request,
        Array.from(input.allowedOriginHostnames ?? [targetHostname])
      )

      if (rejected !== undefined) {
        return rejected
      }

      if (!request.headers.has('mcp-protocol-version')) {
        if (request.method !== 'POST') {
          const body = yield* methodNotAllowedBody()

          return jsonResponse(body, { status: 405, headers: { allow: 'POST' } })
        }

        const body = yield* Effect.tryPromise({
          try: () => request.text(),
          catch: error => `Could not read request body: ${unknownToMessage(error)}`
        }).pipe(Effect.result)

        if (Result.isFailure(body)) {
          return jsonResponse(yield* badRequestBody(body.failure))
        }

        const responseBody = yield* handleJson(body.success).pipe(
          Effect.catch(error => badRequestBody(error.message))
        )

        return jsonResponse(responseBody)
      }

      return yield* handleSdkHttpRequest(request)
    })

  const handleSdkHttpRequest = (request: Request) =>
    Effect.gen(function* () {
      // Read before `fetch` consumes the body.
      const listen = yield* isListenRequest(request)

      // Tool calls run as fibers of this request: closing the scope below interrupts and awaits any
      // still running (a cancelled call's finalizers), so no tool outlives the caller's scope.
      const toolFibers = yield* FiberSet.make()
      const runTool = yield* FiberSet.runtimePromise(toolFibers)<R>()
      const handler = createMcpHandler(context => makeSdkServer(runTool, context.era))

      return yield* Effect.acquireUseRelease(
        Effect.succeed(handler),
        current =>
          Effect.tryPromise(() => current.fetch(request)).pipe(
            Effect.matchEffect({
              onFailure: error =>
                badRequestBody(unknownToMessage(error)).pipe(
                  Effect.map(body => jsonResponse(body, { status: 400 }))
                ),
              onSuccess: response =>
                completedExchange(response, listen).pipe(
                  Effect.catch(error =>
                    internalErrorBody(error).pipe(
                      Effect.map(body => jsonResponse(body, { status: 500 }))
                    )
                  )
                )
            })
          ),
        current => Effect.promise(() => current.close()).pipe(Effect.catch(() => Effect.void))
      )
    }).pipe(Effect.scoped)

  return { handleLine, handleJson, handleHttpRequest }
}
