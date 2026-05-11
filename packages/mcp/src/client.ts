import { Effect, Option } from 'effect'
import * as Schema from 'effect/Schema'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
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

const validateRemoteUrl = (
  config: Extract<McpServerConfig, { type: 'remote' }>,
  policy: McpSecurityPolicy
) =>
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

    if (policy.allowDevHttpLocalhost && url.protocol === 'http:' && url.hostname === 'localhost') {
      return url.toString()
    }

    return yield* fail(config.name, 'Remote MCP requires https: URL', 'security')
  })

const validateLocal = (
  config: Extract<McpServerConfig, { type: 'local' }>,
  policy: McpSecurityPolicy
) =>
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

const requestRemote = (
  config: Extract<McpServerConfig, { type: 'remote' }>,
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
  }).pipe(Effect.provide(FetchHttpClient.layer))

const notifyRemote = (
  config: Extract<McpServerConfig, { type: 'remote' }>,
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
  }).pipe(Effect.provide(FetchHttpClient.layer))

const requestRemoteSession = (
  config: Extract<McpServerConfig, { type: 'remote' }>,
  request: JsonRpcRequest,
  options?: McpClientOptions
) =>
  Effect.gen(function* () {
    yield* requestRemote(config, initializeRequest(options), options)
    yield* notifyRemote(config, makeInitializedNotification(), options)
    return yield* requestRemote(config, request, options)
  })

type PendingRequest = {
  readonly resolve: (response: JsonRpcResponse) => void
  readonly reject: (error: McpError) => void
}

const requestLocal = (
  config: Extract<McpServerConfig, { type: 'local' }>,
  requests: ReadonlyArray<JsonRpcRequest | JsonRpcNotification>,
  expectedResponses: number,
  options?: McpClientOptions
) =>
  Effect.callback<JsonRpcResponse[], McpError>(resume => {
    const policy = securityPolicy(options)
    if (!policy.allowLocalServers) {
      resume(fail(config.name, 'Local MCP servers are disabled by policy', 'security'))
      return Effect.void
    }

    const command = config.command[0]
    if (command === undefined) {
      resume(fail(config.name, 'Local MCP command must not be empty', 'validation'))
      return Effect.void
    }
    const args = config.command.slice(1)
    const child = spawn(command, args, {
      env: { NODE_ENV: 'production', ...(config.environment ?? {}) },
      stdio: 'pipe'
    })
    const pending = new Map<string | number, PendingRequest>()
    const responses: JsonRpcResponse[] = []
    const timeout = setTimeout(() => {
      closeChild(child)
      resume(fail(config.name, 'Local MCP request timed out', 'timeout'))
    }, timeoutMs(options))

    const finish = () => {
      if (responses.length >= expectedResponses) {
        clearTimeout(timeout)
        closeChild(child)
        resume(Effect.succeed(responses))
      }
    }

    child.on('error', error => {
      clearTimeout(timeout)
      resume(fail(config.name, `Local MCP process failed: ${unknownToMessage(error)}`, 'transport'))
    })

    child.stderr.on('data', () => {
      // Intentionally discard stderr; it can contain secrets from local servers.
    })

    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      Effect.runPromise(decodeJsonRpcResponseFromJson(config.name, line)).then(
        response => {
          const requestId = response.id
          if (requestId !== null) {
            const match = pending.get(requestId)
            if (match !== undefined) {
              pending.delete(requestId)
              match.resolve(response)
            }
          }
        },
        error => {
          clearTimeout(timeout)
          closeChild(child)
          resume(
            fail(config.name, `Invalid local MCP response: ${unknownToMessage(error)}`, 'protocol')
          )
        }
      )
    })

    const send = (request: JsonRpcRequest) =>
      new Promise<JsonRpcResponse>((resolve, reject) => {
        pending.set(request.id, { resolve, reject })
        child.stdin.write(`${JSON.stringify(request)}\n`)
      })

    const run = async () => {
      for (const request of requests) {
        if ('id' in request) {
          responses.push(await send(request))
          finish()
        } else {
          child.stdin.write(`${JSON.stringify(request)}\n`)
        }
      }
    }

    run().catch(error => {
      clearTimeout(timeout)
      closeChild(child)
      resume(fail(config.name, `Local MCP write failed: ${unknownToMessage(error)}`, 'transport'))
    })

    return Effect.sync(() => {
      clearTimeout(timeout)
      closeChild(child)
    })
  })

const closeChild = (child: ReturnType<typeof spawn>) => {
  child.stdin?.end()
  child.kill('SIGTERM')
}

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

export const callMcpServerTool = (input: {
  readonly config: McpServerConfig
  readonly mcpToolName: string
  readonly toolCallId: string
  readonly params: unknown
  readonly options?: McpClientOptions
}): Effect.Effect<ToolResult, McpError> =>
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
