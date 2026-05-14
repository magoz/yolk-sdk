import { Duration, Effect, Option, Stream } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/unstable/http'
import { ChildProcess } from 'effect/unstable/process'
import type { ChildProcessSpawner } from 'effect/unstable/process'
import type { ToolResult } from '@yolk/agent/protocol'
import type {
  McpClientInfo,
  McpLocalServerConfig,
  McpRemoteServerConfig,
  McpSecurityPolicy,
  McpServerConfig
} from './config.ts'
import { defaultMcpClientInfo, defaultMcpSecurityPolicy } from './config.ts'
import { McpError } from './errors.ts'
import {
  decodeJsonRpcResponseFromJson,
  decodeToolCallResult,
  decodeToolsListResult,
  encodeJsonRpcMessage,
  jsonRpcErrorToMcpError,
  makeInitializedNotification,
  makeInitializeParams,
  makeJsonRpcRequest,
  mcpToolToToolDef,
  toolCallResultToToolResult,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse
} from './protocol.ts'

const defaultRequestTimeoutMs = 30_000

export type McpClientOptions = {
  readonly clientInfo?: McpClientInfo
  readonly securityPolicy?: McpSecurityPolicy
  readonly timeoutMs?: number
}

export type McpResolvedTool = {
  readonly serverName: string
  readonly mcpToolName: string
  readonly def: ReturnType<typeof mcpToolToToolDef>
}

const unknownToMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const timeoutMs = (options?: McpClientOptions) => options?.timeoutMs ?? defaultRequestTimeoutMs

const clientInfo = (options?: McpClientOptions) => options?.clientInfo ?? defaultMcpClientInfo

const securityPolicy = (options?: McpClientOptions) =>
  options?.securityPolicy ?? defaultMcpSecurityPolicy

const fail = (server: string, message: string, cause: McpError['cause']) =>
  Effect.fail(new McpError({ server, message, cause }))

const validateRemoteUrl = (config: McpRemoteServerConfig, policy: McpSecurityPolicy) =>
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

const validateLocal = (config: McpLocalServerConfig, policy: McpSecurityPolicy) =>
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
    const candidates = [
      body,
      ...body
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => line.substring('data: '.length))
    ]
    const parsed = yield* Effect.forEach(candidates, candidate =>
      decodeJsonRpcResponseFromJson(server, candidate).pipe(Effect.option)
    ).pipe(Effect.map(Option.firstSomeOf))

    if (Option.isSome(parsed)) {
      return parsed.value
    }

    return yield* fail(server, 'MCP response did not contain a JSON-RPC message', 'protocol')
  })

const unwrapResponse = (server: string, response: JsonRpcResponse) =>
  'error' in response
    ? Effect.fail(jsonRpcErrorToMcpError(server, response.error))
    : Effect.succeed(response.result)

const mapUnknownToMcpError =
  (server: string, message: string, cause: McpError['cause']) => (error: unknown) =>
    error instanceof McpError
      ? error
      : new McpError({
          server,
          message: `${message}: ${unknownToMessage(error)}`,
          cause
        })

const findDuplicateToolName = (tools: ReadonlyArray<McpResolvedTool>) => {
  const names = tools.map(tool => tool.def.name)
  return Option.fromNullishOr(names.find((name, index) => names.indexOf(name) !== index))
}

const requestRemote = (
  config: McpRemoteServerConfig,
  request: JsonRpcRequest,
  options?: McpClientOptions
) =>
  Effect.gen(function* () {
    const policy = securityPolicy(options)
    const url = yield* validateRemoteUrl(config, policy)
    const http = yield* HttpClient.HttpClient
    const body = yield* encodeJsonRpcMessage(config.name, request)
    const encoded = HttpClientRequest.post(url).pipe(
      HttpClientRequest.accept('application/json, text/event-stream'),
      HttpClientRequest.setHeaders(config.headers ?? {}),
      HttpClientRequest.bodyText(body, 'application/json')
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
          duration: Duration.millis(timeoutMs(options)),
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
  config: McpRemoteServerConfig,
  notification: JsonRpcNotification,
  options?: McpClientOptions
) =>
  Effect.gen(function* () {
    const policy = securityPolicy(options)
    const url = yield* validateRemoteUrl(config, policy)
    const http = yield* HttpClient.HttpClient
    const body = yield* encodeJsonRpcMessage(config.name, notification)
    const encoded = HttpClientRequest.post(url).pipe(
      HttpClientRequest.accept('application/json, text/event-stream'),
      HttpClientRequest.setHeaders(config.headers ?? {}),
      HttpClientRequest.bodyText(body, 'application/json')
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
          duration: Duration.millis(timeoutMs(options)),
          orElse: () => fail(config.name, 'MCP notification timed out', 'timeout')
        })
      )
  })

const requestRemoteSession = (
  config: McpRemoteServerConfig,
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
  config: McpLocalServerConfig,
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
      env: config.environment ?? {},
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
      decodeJsonRpcResponseFromJson(config.name, line)
    )

    if (responses.length < expectedResponses) {
      return yield* fail(config.name, 'Local MCP did not return expected response', 'protocol')
    }

    return responses
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: Duration.millis(timeoutMs(options)),
      orElse: () => fail(config.name, 'Local MCP request timed out', 'timeout')
    }),
    Effect.mapError(mapUnknownToMcpError(config.name, 'Local MCP request failed', 'transport'))
  )
}

const requestLocal = (
  config: McpLocalServerConfig,
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

const responseById = (responses: ReadonlyArray<JsonRpcResponse>, id: string | number) =>
  Option.fromNullishOr(responses.find(response => response.id === id))

const requestLocalSession = (
  config: McpLocalServerConfig,
  request: JsonRpcRequest,
  options?: McpClientOptions
) =>
  Effect.gen(function* () {
    const initialize = initializeRequest(options)
    const responses = yield* requestLocal(
      config,
      [initialize, makeInitializedNotification(), request],
      2,
      options
    )
    const initializeResponse = responseById(responses, initialize.id)
    if (Option.isNone(initializeResponse)) {
      return yield* fail(config.name, 'Local MCP did not return initialize response', 'protocol')
    }
    yield* unwrapResponse(config.name, initializeResponse.value)

    return responses
  }).pipe(
    Effect.flatMap(responses => {
      const response = responseById(responses, request.id)
      return Option.isNone(response)
        ? fail(config.name, 'Local MCP did not return expected response', 'protocol')
        : unwrapResponse(config.name, response.value)
    })
  )

const resolveMcpTools = (config: McpServerConfig, result: unknown) =>
  Effect.gen(function* () {
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

export const listRemoteMcpServerTools = (
  config: McpRemoteServerConfig,
  options?: McpClientOptions
): Effect.Effect<ReadonlyArray<McpResolvedTool>, McpError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (config.enabled === false) {
      return []
    }

    const result = yield* requestRemoteSession(config, listToolsRequest(), options)
    return yield* resolveMcpTools(config, result)
  })

export const listLocalMcpServerTools = (
  config: McpLocalServerConfig,
  options?: McpClientOptions
): Effect.Effect<
  ReadonlyArray<McpResolvedTool>,
  McpError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    if (config.enabled === false) {
      return []
    }

    yield* validateLocal(config, securityPolicy(options))
    const result = yield* requestLocalSession(config, listToolsRequest(), options)
    return yield* resolveMcpTools(config, result)
  })

export const listMcpServerTools = (config: McpServerConfig, options?: McpClientOptions) =>
  Effect.gen(function* () {
    if (config.enabled === false) {
      return []
    }

    if (config.type === 'local') {
      return yield* listLocalMcpServerTools(config, options)
    }

    return yield* listRemoteMcpServerTools(config, options)
  })

export type CallMcpServerToolInput = {
  readonly config: McpServerConfig
  readonly mcpToolName: string
  readonly toolCallId: string
  readonly params: unknown
  readonly options?: McpClientOptions
}

const resolveMcpToolResult = (input: CallMcpServerToolInput, result: unknown) =>
  Effect.gen(function* () {
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

    return toolCallResultToToolResult({ toolCallId: input.toolCallId, result: toolCallResult })
  })

export const callRemoteMcpServerTool = (
  input: Omit<CallMcpServerToolInput, 'config'> & { readonly config: McpRemoteServerConfig }
): Effect.Effect<ToolResult, McpError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const result = yield* requestRemoteSession(
      input.config,
      callToolRequest({ toolName: input.mcpToolName, params: input.params }),
      input.options
    )
    return yield* resolveMcpToolResult(input, result)
  })

export const callLocalMcpServerTool = (
  input: Omit<CallMcpServerToolInput, 'config'> & { readonly config: McpLocalServerConfig }
): Effect.Effect<ToolResult, McpError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const result = yield* requestLocalSession(
      input.config,
      callToolRequest({ toolName: input.mcpToolName, params: input.params }),
      input.options
    )
    return yield* resolveMcpToolResult(input, result)
  })

export const callMcpServerTool = (
  input: CallMcpServerToolInput
): Effect.Effect<
  ToolResult,
  McpError,
  ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> =>
  input.config.type === 'local'
    ? callLocalMcpServerTool({
        config: input.config,
        mcpToolName: input.mcpToolName,
        toolCallId: input.toolCallId,
        params: input.params,
        options: input.options
      })
    : callRemoteMcpServerTool({
        config: input.config,
        mcpToolName: input.mcpToolName,
        toolCallId: input.toolCallId,
        params: input.params,
        options: input.options
      })

export const listMcpTools = (configs: ReadonlyArray<McpServerConfig>, options?: McpClientOptions) =>
  Effect.flatMap(
    Effect.forEach(configs, config => listMcpServerTools(config, options)),
    tools => {
      const resolved = tools.flat()
      const duplicate = findDuplicateToolName(resolved)
      if (Option.isSome(duplicate)) {
        return fail('mcp', `Duplicate MCP tool name: ${duplicate.value}`, 'validation')
      }

      return Effect.succeed(resolved)
    }
  )
