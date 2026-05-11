import { Effect, Option, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { NodeServices } from '@effect/platform-node'
import { HttpClient, HttpClientRequest } from 'effect/unstable/http'
import { ChildProcess } from 'effect/unstable/process'
import type { ToolResult } from '@yolk/protocol'
import type { McpClientInfo, McpSecurityPolicy, McpServerConfig } from './config'
import { defaultMcpClientInfo, defaultMcpSecurityPolicy } from './config'
import { McpError } from './errors'
import {
  decodeJsonRpcResponseFromJson,
  decodeToolCallResult,
  decodeToolsListResult,
  jsonRpcErrorToMcpError,
  makeInitializedNotification,
  makeInitializeParams,
  makeJsonRpcRequest,
  mcpToolToToolDef,
  toolCallResultToToolResult,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse
} from './protocol'

const defaultRequestTimeoutMs = 30_000

type McpClientOptions = {
  readonly clientInfo?: McpClientInfo
  readonly securityPolicy?: McpSecurityPolicy
  readonly timeoutMs?: number
}

type RemoteMcpServerConfig = Extract<McpServerConfig, { type: 'remote' }>
type LocalMcpServerConfig = Extract<McpServerConfig, { type: 'local' }>

export type McpResolvedTool = {
  readonly serverName: string
  readonly mcpToolName: string
  readonly def: ReturnType<typeof mcpToolToToolDef>
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

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const timeoutMs = (options?: McpClientOptions) => options?.timeoutMs ?? defaultRequestTimeoutMs

const clientInfo = (options?: McpClientOptions) => options?.clientInfo ?? defaultMcpClientInfo

const securityPolicy = (options?: McpClientOptions) =>
  options?.securityPolicy ?? defaultMcpSecurityPolicy

const fail = (server: string, message: string, cause: McpError['cause']) =>
  Effect.fail(new McpError({ server, message, cause }))

const validateRemoteUrl = (config: RemoteMcpServerConfig, policy: McpSecurityPolicy) =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(config.url),
      catch: error =>
        new McpError({
          server: config.name,
          message: `Invalid MCP server URL: ${unknownToMessage(error)}`,
          cause: 'validation'
        })
    })

    if (url.protocol === 'https:') {
      return url.toString()
    }

    if (
      policy.allowDevHttpLocalhost &&
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    ) {
      return url.toString()
    }

    return yield* fail(config.name, 'Remote MCP requires https: URL', 'security')
  })

const validateLocal = (config: LocalMcpServerConfig, policy: McpSecurityPolicy) =>
  Effect.gen(function* () {
    if (!policy.allowLocalServers) {
      return yield* fail(config.name, 'Local MCP servers are disabled by policy', 'security')
    }

    if (config.command.length === 0) {
      return yield* fail(config.name, 'Local MCP command must not be empty', 'validation')
    }
  })

const parseSseJsonRpcResponse = (server: string, body: string) =>
  Effect.gen(function* () {
    const direct = yield* decodeJsonRpcResponseFromJson(server, body).pipe(Effect.option)

    if (Option.isSome(direct)) {
      return direct.value
    }

    for (const line of body.split('\n')) {
      if (line.startsWith('data: ')) {
        const parsed = yield* decodeJsonRpcResponseFromJson(
          server,
          line.substring('data: '.length)
        ).pipe(Effect.option)
        if (Option.isSome(parsed)) {
          return parsed.value
        }
      }
    }

    return yield* fail(server, 'MCP response did not contain a JSON-RPC message', 'protocol')
  })

const unwrapResponse = (server: string, response: JsonRpcResponse) =>
  'error' in response
    ? Effect.fail(jsonRpcErrorToMcpError(server, response.error))
    : Effect.succeed(response.result)

const encodeJsonRpcMessage = (server: string, message: JsonRpcRequest | JsonRpcNotification) =>
  Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(message).pipe(
    Effect.mapError(
      error =>
        new McpError({
          server,
          message: `Could not encode MCP JSON-RPC message: ${unknownToMessage(error)}`,
          cause: 'validation'
        })
    )
  )

const mapUnknownToMcpError =
  (server: string, message: string, cause: McpError['cause']) => (error: unknown) =>
    error instanceof McpError
      ? error
      : new McpError({
          server,
          message: `${message}: ${unknownToMessage(error)}`,
          cause
        })

const requestRemote = (
  config: RemoteMcpServerConfig,
  request: JsonRpcRequest,
  options?: McpClientOptions
) =>
  Effect.gen(function* () {
    const policy = securityPolicy(options)
    const url = yield* validateRemoteUrl(config, policy)
    const http = yield* HttpClient.HttpClient
    const encoded = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.accept('application/json, text/event-stream'),
      HttpClientRequest.setHeaders(config.headers ?? {}),
      HttpClientRequest.schemaBodyJson(JsonRpcRequestSchema)(request),
      Effect.mapError(
        error =>
          new McpError({
            server: config.name,
            message: `Could not encode MCP request: ${unknownToMessage(error)}`,
            cause: 'validation'
          })
      )
    )
    const response = yield* HttpClient.filterStatusOk(http)
      .execute(encoded)
      .pipe(
        Effect.mapError(
          error =>
            new McpError({
              server: config.name,
              message: `MCP request failed: ${unknownToMessage(error)}`,
              cause: 'transport'
            })
        ),
        Effect.timeoutOrElse({
          duration: timeoutMs(options),
          orElse: () => fail(config.name, 'MCP request timed out', 'timeout')
        })
      )
    const text = yield* response.text.pipe(
      Effect.mapError(
        error =>
          new McpError({
            server: config.name,
            message: `Could not read MCP response: ${unknownToMessage(error)}`,
            cause: 'transport'
          })
      )
    )
    const decoded = yield* parseSseJsonRpcResponse(config.name, text)

    return yield* unwrapResponse(config.name, decoded)
  })

const notifyRemote = (
  config: RemoteMcpServerConfig,
  notification: JsonRpcNotification,
  options?: McpClientOptions
) =>
  Effect.gen(function* () {
    const policy = securityPolicy(options)
    const url = yield* validateRemoteUrl(config, policy)
    const http = yield* HttpClient.HttpClient
    const encoded = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.accept('application/json, text/event-stream'),
      HttpClientRequest.setHeaders(config.headers ?? {}),
      HttpClientRequest.schemaBodyJson(JsonRpcNotificationSchema)(notification),
      Effect.mapError(
        error =>
          new McpError({
            server: config.name,
            message: `Could not encode MCP notification: ${unknownToMessage(error)}`,
            cause: 'validation'
          })
      )
    )
    yield* HttpClient.filterStatusOk(http)
      .execute(encoded)
      .pipe(
        Effect.mapError(
          error =>
            new McpError({
              server: config.name,
              message: `MCP notification failed: ${unknownToMessage(error)}`,
              cause: 'transport'
            })
        ),
        Effect.timeoutOrElse({
          duration: timeoutMs(options),
          orElse: () => fail(config.name, 'MCP notification timed out', 'timeout')
        })
      )
  })

const requestRemoteSession = (
  config: RemoteMcpServerConfig,
  request: JsonRpcRequest,
  options?: McpClientOptions
) =>
  Effect.gen(function* () {
    yield* requestRemote(config, initializeRequest(options), options)
    yield* notifyRemote(config, makeInitializedNotification(), options)
    return yield* requestRemote(config, request, options)
  })

type EncodedLocalMessage = {
  readonly message: JsonRpcRequest | JsonRpcNotification
  readonly line: string
}

const requestLocalEncoded = (
  config: LocalMcpServerConfig,
  messages: ReadonlyArray<EncodedLocalMessage>,
  expectedResponses: number,
  options?: McpClientOptions
) => {
  const policy = securityPolicy(options)
  if (!policy.allowLocalServers) {
    return fail(config.name, 'Local MCP servers are disabled by policy', 'security')
  }

  const command = config.command[0]
  if (command === undefined) {
    return fail(config.name, 'Local MCP command must not be empty', 'validation')
  }

  return Effect.gen(function* () {
    const stdin = Stream.fromIterable(messages.map(message => `${message.line}\n`)).pipe(
      Stream.encodeText
    )
    const child = yield* ChildProcess.make(command, config.command.slice(1), {
      env: { NODE_ENV: 'production', ...(config.environment ?? {}) },
      extendEnv: false,
      stdin: { stream: stdin, endOnDone: true },
      stderr: 'ignore'
    })
    const lines = yield* child.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.filter(line => line.length > 0),
      Stream.take(expectedResponses),
      Stream.runCollect
    )
    const responses = yield* Effect.forEach(lines, line =>
      decodeJsonRpcResponseFromJson(config.name, line).pipe(
        Effect.mapError(mapUnknownToMcpError(config.name, 'Invalid local MCP response', 'protocol'))
      )
    )

    if (responses.length < expectedResponses) {
      return yield* fail(config.name, 'Local MCP did not return expected response', 'protocol')
    }

    return responses
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: timeoutMs(options),
      orElse: () => fail(config.name, 'Local MCP request timed out', 'timeout')
    }),
    Effect.mapError(mapUnknownToMcpError(config.name, 'Local MCP request failed', 'transport')),
    Effect.provide(NodeServices.layer)
  )
}

const requestLocal = (
  config: LocalMcpServerConfig,
  requests: ReadonlyArray<JsonRpcRequest | JsonRpcNotification>,
  expectedResponses: number,
  options?: McpClientOptions
) =>
  Effect.gen(function* () {
    const messages = yield* Effect.forEach(requests, request =>
      encodeJsonRpcMessage(config.name, request).pipe(
        Effect.map(line => ({ message: request, line }))
      )
    )

    return yield* requestLocalEncoded(config, messages, expectedResponses, options)
  })

const initializeRequest = (options?: McpClientOptions) =>
  makeJsonRpcRequest({
    id: 1,
    method: 'initialize',
    params: makeInitializeParams(clientInfo(options))
  })

const listToolsRequest = () => makeJsonRpcRequest({ id: 2, method: 'tools/list' })

const callToolRequest = (input: { readonly toolName: string; readonly params: unknown }) =>
  makeJsonRpcRequest({
    id: 3,
    method: 'tools/call',
    params: { name: input.toolName, arguments: input.params }
  })

const requestServer = (
  config: McpServerConfig,
  request: JsonRpcRequest,
  options?: McpClientOptions
) => {
  if (config.enabled === false) {
    return fail(config.name, 'MCP server is disabled', 'disabled')
  }

  if (config.type === 'remote') {
    return requestRemoteSession(config, request, options)
  }

  return requestLocal(
    config,
    [initializeRequest(options), makeInitializedNotification(), request],
    2,
    options
  ).pipe(
    Effect.flatMap(responses => {
      const response = responses[1]
      return response === undefined
        ? fail(config.name, 'Local MCP did not return expected response', 'protocol')
        : unwrapResponse(config.name, response)
    })
  )
}

export const listMcpServerTools = (config: McpServerConfig, options?: McpClientOptions) =>
  Effect.gen(function* () {
    if (config.enabled === false) {
      return []
    }

    if (config.type === 'local') {
      yield* validateLocal(config, securityPolicy(options))
    }

    const result = yield* requestServer(config, listToolsRequest(), options)
    const tools = yield* decodeToolsListResult(result).pipe(
      Effect.mapError(
        error =>
          new McpError({
            server: config.name,
            message: `Invalid tools/list result: ${unknownToMessage(error)}`,
            cause: 'validation'
          })
      )
    )

    return tools.tools.map(tool => ({
      serverName: config.name,
      mcpToolName: tool.name,
      def: mcpToolToToolDef({ serverName: config.name, tool })
    }))
  })

type CallMcpServerToolInput = {
  readonly config: McpServerConfig
  readonly mcpToolName: string
  readonly toolCallId: string
  readonly params: unknown
  readonly options?: McpClientOptions
}

export const callMcpServerTool = (
  input: CallMcpServerToolInput
): Effect.Effect<ToolResult, McpError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const result = yield* requestServer(
      input.config,
      callToolRequest({ toolName: input.mcpToolName, params: input.params }),
      input.options
    )
    const toolCallResult = yield* decodeToolCallResult(result).pipe(
      Effect.mapError(
        error =>
          new McpError({
            server: input.config.name,
            message: `Invalid tools/call result: ${unknownToMessage(error)}`,
            cause: 'validation'
          })
      )
    )

    if (toolCallResult.isError === true) {
      return yield* fail(input.config.name, 'MCP tool returned error', 'tool_error')
    }

    return toolCallResultToToolResult({ toolCallId: input.toolCallId, result: toolCallResult })
  })

export const listMcpTools = (configs: ReadonlyArray<McpServerConfig>, options?: McpClientOptions) =>
  Effect.flatMap(
    Effect.forEach(configs, config => listMcpServerTools(config, options)),
    tools => Effect.succeed(tools.flat())
  )
