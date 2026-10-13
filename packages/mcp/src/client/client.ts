import { Duration, Effect, Option, Stream, Struct } from 'effect'
import * as Schema from 'effect/Schema'
import {
  CLIENT_CAPABILITIES_META_KEY,
  Client as SdkClient,
  fromJsonSchema,
  isInputRequiredResult,
  isSpecType,
  mergeCapabilities,
  MissingRequiredClientCapabilityError,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  type CallToolRequestOptions,
  type CallToolRequestParams,
  type CallToolResult,
  type ClientOptions as SdkClientOptions,
  type ProtocolEra,
  type Tool
} from '@modelcontextprotocol/client'
import { HttpClient } from 'effect/http'
import { ChildProcess } from 'effect/process'
import type { ChildProcessSpawner } from 'effect/process'
import type { ToolResult } from '@yolk-sdk/agent/protocol'
import type {
  McpClientInfo,
  McpLocalServerConfig,
  McpRemoteServerConfig,
  McpSecurityPolicy,
  McpServerConfig
} from './config.ts'
import { defaultMcpClientInfo, defaultMcpSecurityPolicy } from './config.ts'
import {
  decodeMcpInputRequired,
  mcpArgumentsDigest,
  McpPausedTool,
  McpToolCallComplete,
  McpToolCallInputRequired,
  toMcpInputResponses,
  type McpElicitationResponses,
  type McpElicitationSupport,
  type McpInputRequired,
  type McpToolCallOutcome,
  type McpWireElicitResult
} from './elicitation.ts'
import { McpClientCapabilityRequiredError, McpError, McpInputRequiredError } from './errors.ts'
import {
  decodeJsonRpcResponseFromJson,
  decodeToolCallResult,
  decodeToolsListResult,
  encodeJsonRpcMessage,
  InitializeClientInfo,
  InitializeParams,
  InitializedNotification,
  jsonRpcErrorToMcpError,
  JsonRpcRequest,
  legacyMcpProtocolVersion,
  mcpToolToToolDef,
  toolCallResultToToolResult,
  ToolsCallParams,
  type McpToolAnnotations,
  type McpToolExposureResolver,
  type JsonRpcNotification,
  type JsonRpcResponse,
  type ToolsListResult
} from './protocol.ts'
import { makeEffectFetch } from './effect-fetch.ts'

const defaultRequestTimeoutMs = 30_000

export type McpClientOptions = {
  readonly clientInfo?: McpClientInfo
  readonly securityPolicy?: McpSecurityPolicy
  readonly timeoutMs?: number
  readonly sdk?: SdkClientOptions
  readonly configureClient?: (client: SdkClient) => void
  /** Code mode exposure of the listed tools' definitions (listing functions only). */
  readonly exposure?: McpToolExposureResolver
  /**
   * Opt-in MCP form elicitation (multi round-trip requests, protocol `2026-07-28`). When set, the
   * remote listing and the resumable call functions declare `elicitation.form` in the per-request
   * `_meta` client capabilities of a modern connection. It is never declared in a legacy
   * `initialize` (legacy elicitation is a server-initiated request the host would have to answer
   * synchronously), and `callRemoteMcpServerTool`, which cannot represent a paused call, never
   * declares it.
   */
  readonly elicitation?: McpElicitationSupport
}

export type McpResolvedTool = {
  readonly serverName: string
  readonly mcpToolName: string
  readonly title?: string
  readonly outputSchema?: unknown
  readonly annotations?: McpToolAnnotations
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

const sdkFailureCause = (error: unknown): McpError['cause'] => {
  if (error instanceof ProtocolError) {
    return 'protocol'
  }

  if (error instanceof SdkError) {
    if (error.code === SdkErrorCode.RequestTimeout) {
      return 'timeout'
    }

    const message = error.message.toLowerCase()

    return message.includes('content type') || message.includes('json') || message.includes('parse')
      ? 'protocol'
      : 'transport'
  }

  return 'transport'
}

const mapSdkError = (server: string, operation: string) => (error: unknown) =>
  error instanceof McpError
    ? error
    : new McpError({
        server,
        message: `${operation}: ${unknownToMessage(error)}`,
        cause: sdkFailureCause(error)
      })

const withRemoteSdkClient = <A>(
  config: McpRemoteServerConfig,
  options: McpClientOptions | undefined,
  run: (client: SdkClient) => Promise<A>
): Effect.Effect<A, McpError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = yield* validateRemoteUrl(config, securityPolicy(options))
    const http = yield* HttpClient.HttpClient

    const sdkClient = yield* Effect.try({
      try: () => {
        const client = new SdkClient(clientInfo(options), {
          ...options?.sdk,
          versionNegotiation: options?.sdk?.versionNegotiation ?? { mode: 'auto' }
        })

        options?.configureClient?.(client)

        return client
      },
      catch: mapSdkError(config.name, 'Could not configure MCP client')
    })

    const transport = new StreamableHTTPClientTransport(new URL(url), {
      fetch: makeEffectFetch(http),
      requestInit: { headers: new Headers(config.headers) }
    })

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () =>
          sdkClient
            .connect(transport, {
              timeout: timeoutMs(options),
              maxTotalTimeout: timeoutMs(options)
            })
            .then(() => sdkClient),
        catch: mapSdkError(config.name, 'Could not connect to MCP server')
      }),
      () =>
        Effect.tryPromise({
          try: () => run(sdkClient),
          catch: mapSdkError(config.name, 'MCP request failed')
        }),
      () => Effect.promise(() => sdkClient.close()).pipe(Effect.catch(() => Effect.void))
    )
  })

const sdkRequestOptions = (options?: McpClientOptions) => ({
  timeout: timeoutMs(options),
  maxTotalTimeout: timeoutMs(options)
})

const ToolArguments = Schema.Record(Schema.String, Schema.Unknown)

type ToolArguments = typeof ToolArguments.Type

const decodeToolArguments = Schema.decodeUnknownEffect(ToolArguments)

const decodeCallArguments = (server: string, params: unknown) =>
  decodeToolArguments(params).pipe(
    Effect.mapError(
      error =>
        new McpError({
          server,
          message: `Invalid tools/call arguments: ${unknownToMessage(error)}`,
          cause: 'validation'
        })
    )
  )

const decodeCallResult = (server: string, result: unknown) =>
  decodeToolCallResult(result).pipe(
    Effect.mapError(
      error =>
        new McpError({
          server,
          message: `Invalid tools/call result: ${unknownToMessage(error)}`,
          cause: 'validation'
        })
    )
  )

/**
 * The per-request `_meta` that declares form elicitation: only on a modern connection, and only
 * when the host opted in. It replaces the SDK's own client-capabilities key, so it carries the
 * host's `sdk.capabilities` too (capabilities registered in `configureClient` are not merged).
 */
const elicitationMeta = (client: SdkClient, options: McpClientOptions | undefined) =>
  options?.elicitation === undefined || client.getProtocolEra() !== 'modern'
    ? undefined
    : {
        [CLIENT_CAPABILITIES_META_KEY]: mergeCapabilities(options.sdk?.capabilities ?? {}, {
          elicitation: { form: {} }
        })
      }

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

const initializeRequest = (options?: McpClientOptions) => {
  const info = clientInfo(options)

  return JsonRpcRequest.make({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: InitializeParams.make({
      protocolVersion: legacyMcpProtocolVersion,
      capabilities: {},
      clientInfo: InitializeClientInfo.make({ name: info.name, version: info.version })
    })
  })
}

const listToolsRequest = () =>
  JsonRpcRequest.make({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list'
  })

const callToolRequest = (input: { readonly toolName: string; readonly params: unknown }) =>
  JsonRpcRequest.make({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: ToolsCallParams.make({
      name: input.toolName,
      arguments: input.params
    })
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
      [
        initialize,
        InitializedNotification.make({
          jsonrpc: '2.0',
          method: 'notifications/initialized'
        }),
        request
      ],
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

const resolvedMcpTools = (
  config: McpServerConfig,
  listed: ToolsListResult,
  options: McpClientOptions | undefined
) =>
  listed.tools.map(tool => ({
    serverName: config.name,
    mcpToolName: tool.name,
    title: tool.title,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    def:
      options?.exposure === undefined
        ? mcpToolToToolDef({ serverName: config.name, tool })
        : mcpToolToToolDef({ serverName: config.name, tool, exposure: options.exposure })
  }))

export const listRemoteMcpServerTools = (
  config: McpRemoteServerConfig,
  options?: McpClientOptions
): Effect.Effect<ReadonlyArray<McpResolvedTool>, McpError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (config.enabled === false) {
      return []
    }

    const result = yield* withRemoteSdkClient(config, options, client => {
      const meta = elicitationMeta(client, options)

      return client.listTools(
        meta === undefined ? undefined : { _meta: meta },
        sdkRequestOptions(options)
      )
    })

    const listed = yield* decodeToolsListResult(result).pipe(
      Effect.mapError(
        error =>
          new McpError({
            server: config.name,
            message: `Invalid tools/list result: ${unknownToMessage(error)}`,
            cause: 'validation'
          })
      )
    )

    return resolvedMcpTools(config, listed, options)
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

    const listed = yield* decodeToolsListResult(result).pipe(
      Effect.mapError(
        error =>
          new McpError({
            server: config.name,
            message: `Invalid tools/list result: ${unknownToMessage(error)}`,
            cause: 'validation'
          })
      )
    )

    return resolvedMcpTools(config, listed, options)
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

export const callRemoteMcpServerTool = (
  input: Omit<CallMcpServerToolInput, 'config'> & { readonly config: McpRemoteServerConfig }
): Effect.Effect<ToolResult, McpError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const args = yield* decodeCallArguments(input.config.name, input.params)

    const result = yield* withRemoteSdkClient(input.config, input.options, async client => {
      await client.listTools(undefined, sdkRequestOptions(input.options))

      return client.callTool(
        { name: input.mcpToolName, arguments: args },
        sdkRequestOptions(input.options)
      )
    })

    const toolCallResult = yield* decodeCallResult(input.config.name, result)

    return toolCallResultToToolResult({ toolCallId: input.toolCallId, result: toolCallResult })
  })

export type CallRemoteMcpServerToolInput = Omit<CallMcpServerToolInput, 'config'> & {
  readonly config: McpRemoteServerConfig
}

export type ResumeRemoteMcpServerToolCallInput = CallRemoteMcpServerToolInput & {
  /** The paused call, exactly as the previous step answered it (persisted by the host). */
  readonly inputRequired: McpInputRequired
  /** One decision per elicitation, keyed by `McpFormElicitation.key`. */
  readonly responses: McpElicitationResponses
}

export type McpResumableToolCallError =
  | McpError
  | McpInputRequiredError
  | McpClientCapabilityRequiredError

type RetryParams = {
  inputResponses?: Record<string, McpWireElicitResult>
  requestState?: string
}

/** The first step lists, then calls; a resume calls with the paused tool's definition. */
type ResumableMode =
  | { readonly kind: 'initial' }
  | {
      readonly kind: 'resume'
      readonly retry: RetryParams
      readonly tool: McpPausedTool | undefined
    }

type ResumableStep =
  | {
      readonly kind: 'answered'
      readonly era: ProtocolEra | undefined
      readonly raw: unknown
      readonly tool: McpPausedTool | undefined
    }
  | {
      readonly kind: 'capability_required'
      readonly message: string
      readonly requiredCapabilities: unknown
    }
  | { readonly kind: 'missing_input_required_payload'; readonly message: string }
  | { readonly kind: 'legacy_resume' }

const InputRequiredMissingBoth = Schema.Struct({
  violation: Schema.Literal('input-required-missing-both')
})

const isInputRequiredMissingBoth = (error: unknown) =>
  error instanceof SdkError &&
  error.code === SdkErrorCode.InvalidResult &&
  Schema.is(InputRequiredMissingBoth)(error.data)

const decodeRequiredCapabilities = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.Unknown)
)

const decodePausedTool = Schema.decodeUnknownOption(McpPausedTool)

/** The SDK `Tool` of a persisted definition (`isSpecType` checks it; no cast). */
const sdkToolOf = (tool: McpPausedTool): Tool | undefined => {
  const candidate = {
    name: tool.name,
    inputSchema: tool.inputSchema,
    ...Option.match(Option.fromNullishOr(tool.outputSchema), {
      onNone: () => ({}),
      onSome: outputSchema => ({ outputSchema })
    })
  }

  return isSpecType.Tool(candidate) ? candidate : undefined
}

/** A definition that keeps the SDK off its response cache when nothing better is known. */
const minimalToolDefinition = (name: string): Tool => ({ name, inputSchema: { type: 'object' } })

type OutputValidator = ReturnType<typeof fromJsonSchema>['~standard']

/**
 * Compiles the tool's `outputSchema` before the call, as the SDK does: a schema that does not
 * compile fails the call before anything is sent.
 */
const compileOutputValidator = (
  tool: Tool,
  options: McpClientOptions | undefined
): OutputValidator | undefined => {
  if (tool.outputSchema === undefined) return undefined

  try {
    return fromJsonSchema(tool.outputSchema, options?.sdk?.jsonSchemaValidator)['~standard']
  } catch (error) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Tool '${tool.name}' has an invalid outputSchema: ${unknownToMessage(error).slice(0, 200)}`
    )
  }
}

/**
 * The official client validates structured output even when the answer is an `input_required`
 * result (manual mode), and then rejects it. The resumable call therefore always passes the
 * tool without its `outputSchema` as `toolDefinition` (the SDK never reads its response cache)
 * and checks complete results here, with the SDK's rules and the host's `sdk.jsonSchemaValidator`.
 */
const assertStructuredOutput = async (
  toolName: string,
  validator: OutputValidator,
  result: CallToolResult
) => {
  if (result.isError === true) return

  if (result.structuredContent === undefined) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidRequest,
      `Tool ${toolName} has an output schema but did not return structured content`
    )
  }

  const outcome = await Promise.resolve()
    .then(() => validator.validate(result.structuredContent))
    .catch((error: unknown) => {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Failed to validate structured content: ${unknownToMessage(error)}`
      )
    })

  if (outcome.issues !== undefined) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Structured content does not match the tool's output schema: ${outcome.issues
        .map(issue => issue.message)
        .join('; ')}`
    )
  }
}

/**
 * One wire step of a resumable call on a fresh connection. The first step lists, then calls (as
 * `callRemoteMcpServerTool` does). A resume lists nothing: it calls with the definition carried
 * by the pause (or a minimal one) and is re-sent as a new request on a new connection.
 */
const resumableStep = (
  input: CallRemoteMcpServerToolInput,
  args: ToolArguments,
  mode: ResumableMode
) =>
  withRemoteSdkClient(input.config, input.options, async (client): Promise<ResumableStep> => {
    const era = client.getProtocolEra()

    if (mode.kind === 'resume' && era !== 'modern') {
      return { kind: 'legacy_resume' }
    }

    const meta = elicitationMeta(client, input.options)

    const listed =
      mode.kind === 'initial'
        ? (
            await client.listTools(
              meta === undefined ? undefined : { _meta: meta },
              sdkRequestOptions(input.options)
            )
          ).tools.find(tool => tool.name === input.mcpToolName)
        : undefined

    const paused =
      mode.kind === 'resume'
        ? mode.tool
        : Option.getOrUndefined(Option.flatMap(Option.fromNullishOr(listed), decodePausedTool))

    const definition =
      mode.kind === 'resume'
        ? Option.getOrUndefined(Option.flatMapNullishOr(Option.fromNullishOr(paused), sdkToolOf))
        : listed

    const validator =
      definition === undefined ? undefined : compileOutputValidator(definition, input.options)

    // The SDK's neutral `CallToolRequestParams` omits the MRTR retry fields; its 2026-07-28 codec
    // sends them as received (its own auto-fulfilment driver retries the same way).
    const params: CallToolRequestParams & RetryParams = {
      name: input.mcpToolName,
      arguments: { ...args }
    }

    if (meta !== undefined) params._meta = meta

    if (mode.kind === 'resume' && mode.retry.inputResponses !== undefined) {
      params.inputResponses = mode.retry.inputResponses
    }

    if (mode.kind === 'resume' && mode.retry.requestState !== undefined) {
      params.requestState = mode.retry.requestState
    }

    const callOptions: CallToolRequestOptions = {
      ...sdkRequestOptions(input.options),
      allowInputRequired: true,
      toolDefinition:
        definition === undefined
          ? minimalToolDefinition(input.mcpToolName)
          : Struct.omit(definition, ['outputSchema'])
    }

    try {
      const result = await client.callTool(params, callOptions)

      if (!isInputRequiredResult(result) && validator !== undefined) {
        await assertStructuredOutput(input.mcpToolName, validator, result)
      }

      return { kind: 'answered', era, raw: result, tool: paused }
    } catch (error) {
      if (error instanceof MissingRequiredClientCapabilityError) {
        return {
          kind: 'capability_required',
          message: error.message,
          requiredCapabilities: error.requiredCapabilities
        }
      }

      if (isInputRequiredMissingBoth(error)) {
        return { kind: 'missing_input_required_payload', message: unknownToMessage(error) }
      }

      throw error
    }
  })

const resumableOutcome = (
  input: CallRemoteMcpServerToolInput,
  step: ResumableStep,
  argumentsDigest: string
): Effect.Effect<McpToolCallOutcome, McpResumableToolCallError> => {
  const server = input.config.name

  switch (step.kind) {
    case 'legacy_resume':
      return Effect.fail(
        new McpInputRequiredError({
          server,
          reason: 'unsupported_era',
          message: 'Cannot resume a tool call: the server negotiated a legacy MCP era'
        })
      )
    case 'capability_required':
      return Effect.fail(
        new McpClientCapabilityRequiredError({
          server,
          message: step.message,
          requiredCapabilities: decodeRequiredCapabilities(step.requiredCapabilities).pipe(
            Option.getOrElse(() => ({}))
          )
        })
      )
    case 'missing_input_required_payload':
      return Effect.fail(
        new McpInputRequiredError({ server, reason: 'malformed', message: step.message })
      )
    case 'answered':
      if (isInputRequiredResult(step.raw)) {
        return step.era === 'modern'
          ? decodeMcpInputRequired({
              server,
              raw: step.raw,
              elicitation: input.options?.elicitation,
              binding: { mcpToolName: input.mcpToolName, argumentsDigest, tool: step.tool }
            }).pipe(Effect.map(inputRequired => McpToolCallInputRequired.make({ inputRequired })))
          : Effect.fail(
              new McpInputRequiredError({
                server,
                reason: 'unsupported_era',
                message: 'A legacy-era server answered with an input-required result'
              })
            )
      }

      return decodeCallResult(server, step.raw).pipe(
        Effect.map(result =>
          McpToolCallComplete.make({
            result: toolCallResultToToolResult({ toolCallId: input.toolCallId, result })
          })
        )
      )
  }
}

const digestCallArguments = (server: string, args: ToolArguments) =>
  mcpArgumentsDigest(args).pipe(
    Effect.mapError(
      error =>
        new McpError({
          server,
          message: `Invalid tools/call arguments: not JSON: ${unknownToMessage(error)}`,
          cause: 'validation'
        })
    )
  )

/**
 * Calls a remote MCP tool and answers a typed outcome instead of blocking on input:
 * `Complete` (the adapted result) or `InputRequired` (a serializable `McpInputRequired` the host
 * persists, decides on, and passes to `resumeRemoteMcpServerToolCall`). Like
 * `callRemoteMcpServerTool`, it lists tools on its own connection before calling; the pause
 * carries the listed definition. Set `options.elicitation` to declare form elicitation; without
 * it a server may refuse a tool that needs confirmation (`McpClientCapabilityRequiredError` for
 * MCP `-32021`, or a tool error result).
 */
export const callRemoteMcpServerToolResumable = (
  input: CallRemoteMcpServerToolInput
): Effect.Effect<McpToolCallOutcome, McpResumableToolCallError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const args = yield* decodeCallArguments(input.config.name, input.params)
    const argumentsDigest = yield* digestCallArguments(input.config.name, args)
    const step = yield* resumableStep(input, args, { kind: 'initial' })

    return yield* resumableOutcome(input, step, argumentsDigest)
  })

/**
 * Resumes a paused remote MCP tool call: the same tool call (same `mcpToolName` and `params`,
 * checked against the pause's binding) is re-sent as a new request on a new connection, with the
 * exact `requestState`, the host's decisions as `inputResponses`, and the pause's tool definition
 * (no listing). The server may pause again (`InputRequired`). Fails with `McpInputRequiredError`
 * before sending when the call does not match the pause (`mismatched_resume`) or `responses` do
 * not match the elicitations (`invalid_responses`), and when the server now negotiates a legacy
 * era (`unsupported_era`).
 */
export const resumeRemoteMcpServerToolCall = (
  input: ResumeRemoteMcpServerToolCallInput
): Effect.Effect<McpToolCallOutcome, McpResumableToolCallError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const server = input.config.name
    const pause = input.inputRequired
    const args = yield* decodeCallArguments(server, input.params)
    const argumentsDigest = yield* digestCallArguments(server, args)

    if (input.mcpToolName !== pause.mcpToolName || argumentsDigest !== pause.argumentsDigest) {
      return yield* Effect.fail(
        new McpInputRequiredError({
          server,
          reason: 'mismatched_resume',
          message:
            input.mcpToolName === pause.mcpToolName
              ? 'The resume sends other arguments than the paused call'
              : `The resume calls ${input.mcpToolName}, but the pause is for ${pause.mcpToolName}`
        })
      )
    }

    const inputResponses = yield* toMcpInputResponses({
      server,
      inputRequired: pause,
      responses: input.responses
    })

    const retry: RetryParams = {}

    if (pause.elicitations.length > 0) retry.inputResponses = inputResponses

    if (pause.requestState !== undefined) retry.requestState = pause.requestState

    const step = yield* resumableStep(input, args, { kind: 'resume', retry, tool: pause.tool })

    return yield* resumableOutcome(input, step, argumentsDigest)
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
