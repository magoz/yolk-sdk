import { Cause, Data, Effect, Layer, Match, Predicate, Queue, Ref, Stream } from 'effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import {
  HttpClient,
  HttpClientRequest,
  type HttpClientError,
  type HttpClientResponse
} from 'effect/unstable/http'
import * as Socket from 'effect/unstable/socket/Socket'
import {
  LLMDone,
  LLMError,
  LLMProvider,
  LLMReasoningDelta,
  LLMTextDelta,
  LLMToolCall,
  LLMUsage,
  type LLMEvent,
  type LLMRequest
} from '@yolk-sdk/agent/loop'
import {
  AgentInputUsage,
  AgentOutputUsage,
  AgentUsage,
  ProviderErrorInfo,
  ToolCall,
  type ProviderFailureKind
} from '@yolk-sdk/agent/protocol'
import {
  streamOpenAiCodexResponse,
  toOpenAiCodexRequestBody
} from '@yolk-sdk/agent/providers/openai/codex-provider'
import type { TokenBrokerResponse } from '@yolk-sdk/agent/oauth'

export const codexWsUrl = 'https://chatgpt.com/backend-api/codex/responses'

const codexWsBetaHeader = 'responses_websockets=2026-02-06'

const codexInstallationId = 'yolk-cloudflare-agent'

export type CodexWsConfig = {
  readonly token: TokenBrokerResponse
  readonly sessionId?: string
  readonly fallback?: CodexResponsesProxyConfig
}

type CodexResponsesProxyConfig = {
  readonly endpoint: string
  readonly bridgeSecret: string
}

type LLMProviderImpl = ReturnType<typeof LLMProvider.of>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const JsonFromJsonString = Schema.fromJsonString(Schema.Json)

const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  value !== undefined && Predicate.isObjectOrArray(value) && !Array.isArray(value)

const jsonObjectField = (value: Schema.JsonObject, key: string): Schema.Json | undefined =>
  Object.hasOwn(value, key) ? value[key] : undefined

const jsonField = (value: Schema.Json | undefined, key: string): Schema.Json | undefined =>
  value !== undefined && isJsonObject(value) ? jsonObjectField(value, key) : undefined

const stringField = (value: Schema.Json | undefined, key: string) => {
  const raw = jsonField(value, key)

  return Predicate.isString(raw) ? raw : undefined
}

const numberField = (value: Schema.Json | undefined, key: string) => {
  const raw = jsonField(value, key)

  return Predicate.isNumber(raw) ? raw : undefined
}

const jsonObjectFromField = (
  value: Schema.JsonObject,
  key: string
): Schema.JsonObject | undefined => {
  const raw = jsonObjectField(value, key)

  return isJsonObject(raw) ? raw : undefined
}

type CodexHttpResponseHeaders = HttpClientResponse.HttpClientResponse['headers']

const codexProvider = 'openai_codex'

const numericDelayMs = (value: number) =>
  Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined

const headerValue = (headers: CodexHttpResponseHeaders, name: string) => {
  const lowerName = name.toLowerCase()

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return value
    }
  }

  return undefined
}

const parseRetryAfterMs = (value: string | undefined) =>
  value === undefined ? undefined : numericDelayMs(Number(value.trim()))

const parseRetryAfter = (value: string | undefined) => {
  if (value === undefined) return undefined

  const trimmed = value.trim()
  const secondsDelay = numericDelayMs(Number(trimmed) * 1000)

  if (secondsDelay !== undefined) return secondsDelay

  const timestamp = Date.parse(trimmed)

  return Number.isNaN(timestamp) ? undefined : numericDelayMs(timestamp - Date.now())
}

const retryAfterMsFromHeaders = (headers: CodexHttpResponseHeaders | undefined) => {
  if (headers === undefined) return undefined

  return (
    parseRetryAfterMs(headerValue(headers, 'retry-after-ms')) ??
    parseRetryAfter(headerValue(headers, 'retry-after'))
  )
}

const codexFailureKind = (input: {
  readonly status?: number
  readonly providerCode?: string
  readonly message?: string
  readonly body?: string
  readonly fallbackKind?: ProviderFailureKind
}): ProviderFailureKind => {
  const signal = [input.providerCode, input.message, input.body]
    .filter(value => value !== undefined)
    .join(' ')
    .toLowerCase()

  if (
    signal.includes('rate_limit') ||
    signal.includes('rate limit') ||
    signal.includes('too_many_requests') ||
    signal.includes('too many request')
  ) {
    return 'rate_limit'
  }

  if (
    signal.includes('overloaded_error') ||
    signal.includes('overloaded') ||
    signal.includes('overload') ||
    signal.includes('service unavailable')
  ) {
    return 'overloaded'
  }

  if (input.status === 429) return 'rate_limit'

  if (input.status === 529) return 'overloaded'

  if (input.status === 413) return 'context_overflow'

  if (input.status === 401 || input.status === 403) return 'auth'

  if (input.status !== undefined && input.status >= 500) return 'server_error'

  return input.fallbackKind ?? 'unknown'
}

const codexFailureRetryable = (kind: ProviderFailureKind) =>
  kind === 'rate_limit' ||
  kind === 'overloaded' ||
  kind === 'server_error' ||
  kind === 'network' ||
  kind === 'stream'

const codexFailureCause = (kind: ProviderFailureKind): LLMError['cause'] => {
  switch (kind) {
    case 'rate_limit':
      return 'rate_limit'
    case 'overloaded':
      return 'overloaded'
    case 'context_overflow':
      return 'context_overflow'
    case 'invalid_response':
      return 'invalid_response'
    case 'auth':
    case 'network':
    case 'server_error':
    case 'stream':
    case 'unknown':
      return 'provider_error'
  }
}

type CodexProviderInfoFields = {
  readonly provider: typeof codexProvider
  readonly kind: ProviderFailureKind
  status?: number
  providerCode?: string
  retryAfterMs?: number
}

const codexProviderInfo = (input: {
  readonly kind: ProviderFailureKind
  readonly status?: number
  readonly providerCode?: string
  readonly retryAfterMs?: number
}) =>
  ProviderErrorInfo.make(
    (() => {
      const fields: CodexProviderInfoFields = {
        provider: codexProvider,
        kind: input.kind
      }

      if (input.status !== undefined) {
        fields.status = input.status
      }

      if (input.providerCode !== undefined) {
        fields.providerCode = input.providerCode
      }

      if (input.retryAfterMs !== undefined) {
        fields.retryAfterMs = input.retryAfterMs
      }

      return fields
    })()
  )

type CodexProviderInfoInputFields = {
  readonly kind: ProviderFailureKind
  status?: number
  providerCode?: string
  retryAfterMs?: number | undefined
}

type CodexProviderErrorFields = {
  readonly message: string
  status?: number
  headers?: CodexHttpResponseHeaders
  providerCode?: string
  body?: string
  fallbackKind?: ProviderFailureKind
}

const codexProviderError = (input: {
  readonly message: string
  readonly status?: number
  readonly headers?: CodexHttpResponseHeaders
  readonly providerCode?: string
  readonly body?: string
  readonly fallbackKind?: ProviderFailureKind
}) => {
  const kind = codexFailureKind(input)

  const provider = codexProviderInfo(
    (() => {
      const fields: CodexProviderInfoInputFields = {
        kind
      }

      if (input.status !== undefined) {
        fields.status = input.status
      }

      if (input.providerCode !== undefined) {
        fields.providerCode = input.providerCode
      }

      if (input.headers !== undefined) {
        fields.retryAfterMs = retryAfterMsFromHeaders(input.headers)
      }

      return fields
    })()
  )

  return new LLMError({
    cause: codexFailureCause(provider.kind),
    message: input.message,
    retryable: codexFailureRetryable(provider.kind),
    provider
  })
}

const parseWsJson = (text: string): Schema.JsonObject | undefined => {
  const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(JsonFromJsonString)(text))

  return isJsonObject(parsed) ? parsed : undefined
}

const schemaErrorToLlmError = (message: string) => (error: Schema.SchemaError) =>
  new LLMError({
    cause: 'provider_error',
    message: `${message}: ${error.message}`,
    retryable: false
  })

const encodeJson = (value: Schema.Json) =>
  Schema.encodeEffect(JsonFromJsonString)(value).pipe(
    Effect.mapError(schemaErrorToLlmError('Could not serialize Codex WS request'))
  )

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export const toWsRequestBody = (request: LLMRequest) =>
  toOpenAiCodexRequestBody(request, {}).pipe(
    Effect.map(body => ({ type: 'response.create' as const, ...body }))
  )

type CodexWsHeaders = {
  readonly Authorization: string
  readonly 'OpenAI-Beta': string
  readonly 'User-Agent': string
  readonly 'x-client-request-id': string
  readonly 'x-codex-installation-id': string
  readonly 'x-openai-internal-codex-residency': string
  readonly originator: string
  'ChatGPT-Account-Id'?: string
  session_id?: string
}

export const codexWsHeaders = (
  config: Pick<CodexWsConfig, 'token' | 'sessionId'>
): CodexWsHeaders => {
  const headers: CodexWsHeaders = {
    Authorization: `Bearer ${config.token.accessToken}`,
    'OpenAI-Beta': codexWsBetaHeader,
    'User-Agent': 'opencode/0.0.0 (cloudflare worker)',
    'x-client-request-id': crypto.randomUUID(),
    'x-codex-installation-id': codexInstallationId,
    'x-openai-internal-codex-residency': 'us',
    originator: 'opencode'
  }

  if (config.token.accountId !== undefined) {
    headers['ChatGPT-Account-Id'] = config.token.accountId
  }

  if (config.sessionId !== undefined) {
    headers['session_id'] = config.sessionId
  }

  return headers
}

// ---------------------------------------------------------------------------
// WS event mapping
// ---------------------------------------------------------------------------

export type WsResult =
  | { readonly _tag: 'Events'; readonly events: ReadonlyArray<LLMEvent> }
  | { readonly _tag: 'Done'; readonly events: ReadonlyArray<LLMEvent> }
  | { readonly _tag: 'Error'; readonly error: LLMError }
  | { readonly _tag: 'Skip' }

const WsResult = Data.taggedEnum<WsResult>()

const parseToolCall = (item: Schema.JsonObject): LLMToolCall | undefined => {
  if (stringField(item, 'type') !== 'function_call') return undefined
  const callId = stringField(item, 'call_id')
  const name = stringField(item, 'name')
  const args = stringField(item, 'arguments')

  if (callId === undefined || name === undefined || args === undefined) return undefined

  const decoded = Schema.decodeUnknownOption(JsonFromJsonString)(args)

  return LLMToolCall.make({
    call: ToolCall.make({ id: callId, name, params: Option.getOrElse(decoded, () => args) })
  })
}

const parseUsage = (response: Schema.JsonObject): LLMUsage | undefined => {
  const usage = jsonObjectFromField(response, 'usage')

  if (usage === undefined) return undefined

  const inputTokens = numberField(usage, 'input_tokens') ?? 0
  const outputTokens = numberField(usage, 'output_tokens') ?? 0
  const inputDetails = jsonObjectFromField(usage, 'input_tokens_details')
  const outputDetails = jsonObjectFromField(usage, 'output_tokens_details')

  return LLMUsage.make({
    usage: AgentUsage.make({
      input: AgentInputUsage.make({
        total: inputTokens,
        uncached:
          inputTokens -
          (inputDetails !== undefined ? (numberField(inputDetails, 'cached_tokens') ?? 0) : 0),
        cacheRead:
          inputDetails !== undefined ? numberField(inputDetails, 'cached_tokens') : undefined
      }),
      output: AgentOutputUsage.make({
        total: outputTokens,
        reasoning:
          outputDetails !== undefined ? numberField(outputDetails, 'reasoning_tokens') : undefined,
        text:
          outputTokens -
          (outputDetails !== undefined ? (numberField(outputDetails, 'reasoning_tokens') ?? 0) : 0)
      })
    })
  })
}

const stopReasonFromCompleted = (
  response: Schema.JsonObject,
  streamedToolCalls: number
): 'stop' | 'tool_use' => {
  if (streamedToolCalls > 0) return 'tool_use'

  const output = jsonObjectField(response, 'output')

  if (!Array.isArray(output)) return 'stop'

  for (const item of output) {
    if (isJsonObject(item) && stringField(item, 'type') === 'function_call') {
      return 'tool_use'
    }
  }

  return 'stop'
}

export const mapWsMessage = (msg: Schema.JsonObject, streamedToolCallCount: number): WsResult => {
  const type = stringField(msg, 'type')

  switch (type) {
    case 'response.output_text.delta':
    case 'response.content_part.delta': {
      const delta = stringField(msg, 'delta')

      if (delta === undefined) return WsResult.Skip()

      return WsResult.Events({ events: [LLMTextDelta.make({ text: delta })] })
    }

    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta': {
      const delta = stringField(msg, 'delta')

      if (delta === undefined) return WsResult.Skip()

      return WsResult.Events({ events: [LLMReasoningDelta.make({ text: delta })] })
    }

    case 'response.output_item.done': {
      const item = jsonObjectFromField(msg, 'item')

      if (item === undefined) return WsResult.Skip()
      const toolCall = parseToolCall(item)

      if (toolCall === undefined) return WsResult.Skip()

      return WsResult.Events({ events: [toolCall] })
    }

    case 'response.completed': {
      const response = jsonObjectFromField(msg, 'response')

      if (response === undefined) {
        return WsResult.Done({ events: [LLMDone.make({ stopReason: 'stop' })] })
      }

      const stopReason = stopReasonFromCompleted(response, streamedToolCallCount)
      const events: Array<LLMEvent> = [LLMDone.make({ stopReason })]
      const usage = parseUsage(response)

      if (usage !== undefined) events.push(usage)

      return WsResult.Done({ events })
    }

    case 'response.failed': {
      const response = jsonObjectFromField(msg, 'response')
      const error = response !== undefined ? jsonObjectFromField(response, 'error') : undefined

      const message =
        error !== undefined
          ? (stringField(error, 'message') ?? 'Codex response failed')
          : 'Codex response failed'

      const providerCode =
        error !== undefined ? (stringField(error, 'code') ?? stringField(error, 'type')) : undefined

      return WsResult.Error({
        error: codexProviderError(
          (() => {
            const fields: CodexProviderErrorFields = {
              message
            }

            if (providerCode !== undefined) {
              fields.providerCode = providerCode
            }

            return fields
          })()
        )
      })
    }

    case 'error': {
      const error = jsonObjectFromField(msg, 'error')

      const message =
        error !== undefined
          ? (stringField(error, 'message') ?? 'Codex WebSocket error')
          : 'Codex WebSocket error'

      const code = error !== undefined ? stringField(error, 'code') : undefined

      return WsResult.Error({
        error: codexProviderError(
          (() => {
            const fields: CodexProviderErrorFields = {
              message
            }

            if (code !== undefined) {
              fields.providerCode = code
            }

            return fields
          })()
        )
      })
    }

    default:
      return WsResult.Skip()
  }
}

// ---------------------------------------------------------------------------
// WS transport — Effect Socket + Cloudflare fetch upgrade
// ---------------------------------------------------------------------------

/**
 * Open a Codex WebSocket via Cloudflare Workers `fetch` upgrade.
 *
 * Workers cannot pass custom headers through `new WebSocket(url)`.
 * Instead, `fetch(url, { headers: { Upgrade: 'websocket', ... } })` returns
 * a Response with a platform `WebSocket` that satisfies `globalThis.WebSocket`.
 */
// Cloudflare Workers Response has `webSocket: WebSocket | null` from
// @cloudflare/workers-types; root tsconfig lacks these types.
// Use `in` narrowing and an unknown capture across DOM and Workers Response types.
const isWebSocketLike = (ws: unknown): ws is WebSocket =>
  Predicate.isObjectOrArray(ws) && ws !== null && 'send' in ws && 'close' in ws

const getWorkersWebSocket = (response: Response): WebSocket | undefined => {
  if (!('webSocket' in response)) return undefined

  const ws: unknown = response.webSocket

  if (ws === null || ws === undefined) return undefined

  return isWebSocketLike(ws) ? ws : undefined
}

type CodexWsLogData =
  | {
      readonly url: string
      readonly hasAccountId: boolean
      readonly hasSessionId: boolean
      readonly headerNames: ReadonlyArray<string>
    }
  | {
      readonly status: number
      readonly hasWebSocket: boolean
      readonly contentType: string | null
      readonly server: string | null
      readonly cfRay: string | null
    }
  | {
      readonly status: number
      readonly cloudflareBlocked: boolean
      readonly bodyPreview: string
    }
  | { readonly status: number }
  | { readonly type: string; readonly readyState: number }
  | { readonly code: number; readonly reason: string; readonly wasClean: boolean }

const logCodexWs = (event: string, data: CodexWsLogData) => {
  console.log(`${event} ${JSON.stringify(data)}`)
}

const isCloudflareBlockedUpgrade = (response: Response, text: string) =>
  response.status === 403 &&
  (response.headers.get('server') === 'cloudflare' ||
    response.headers.get('cf-mitigated') === 'challenge' ||
    text.includes('Sorry, you have been blocked') ||
    text.includes('Attention Required'))

const websocketUpgradeFailureMessage = (response: Response, text: string) =>
  isCloudflareBlockedUpgrade(response, text)
    ? 'Codex direct WebSocket blocked by ChatGPT Cloudflare before upgrade'
    : `Codex WebSocket upgrade failed before connection: HTTP ${response.status}`

const acquireCodexWebSocket = (config: CodexWsConfig) =>
  Effect.tryPromise({
    try: async () => {
      const headers = { ...codexWsHeaders(config), Upgrade: 'websocket' }
      logCodexWs('codex_ws_open_start', {
        url: codexWsUrl,
        hasAccountId: config.token.accountId !== undefined,
        hasSessionId: config.sessionId !== undefined,
        headerNames: Object.keys(headers).sort()
      })
      const response = await fetch(codexWsUrl, { headers })
      const ws = getWorkersWebSocket(response)
      logCodexWs('codex_ws_open_response', {
        status: response.status,
        hasWebSocket: ws !== undefined,
        contentType: response.headers.get('content-type'),
        server: response.headers.get('server'),
        cfRay: response.headers.get('cf-ray')
      })

      if (ws === undefined) {
        const text = await response.text().catch(() => '')
        logCodexWs('codex_ws_open_no_socket', {
          status: response.status,
          cloudflareBlocked: isCloudflareBlockedUpgrade(response, text),
          bodyPreview: text.slice(0, 300)
        })
        throw new Error(websocketUpgradeFailureMessage(response, text))
      }

      if (response.status !== 101) {
        logCodexWs('codex_ws_open_unexpected_status', { status: response.status })
        ws.close(1002, `unexpected upgrade status ${response.status}`)
        throw new Error(`WebSocket upgrade returned unexpected status: ${response.status}`)
      }

      ws.addEventListener(
        'error',
        event => {
          logCodexWs('codex_ws_error_event_before_socket_run', {
            type: event.type,
            readyState: ws.readyState
          })
        },
        { once: true }
      )

      ws.addEventListener(
        'close',
        event => {
          logCodexWs('codex_ws_close_event_before_socket_run', {
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean
          })
        },
        { once: true }
      )

      // Workers WebSocket requires accept() before use; called through
      // property access since DOM WebSocket type lacks it.
      if ('accept' in ws && Predicate.isFunction(ws.accept)) {
        ws.accept()
      }

      return ws
    },
    catch: error =>
      new Socket.SocketOpenError({
        kind: 'Unknown',
        cause: error instanceof Error ? error : new Error(String(error))
      })
  }).pipe(
    Effect.mapError(
      reason =>
        new Socket.SocketError({
          reason
        })
    )
  )

/**
 * Create an Effect Socket from the Cloudflare fetch-upgraded WebSocket.
 *
 * Uses `Socket.fromWebSocket` directly with the already-opened WS —
 * no `WebSocketConstructor` needed.
 */
const makeCodexSocket = (config: CodexWsConfig) =>
  Socket.fromWebSocket(
    Effect.acquireRelease(acquireCodexWebSocket(config), ws =>
      Effect.sync(() => {
        ws.close(1000, 'stream ended')
      })
    ),
    { closeCodeIsError: code => code !== 1000 && code !== 1005 }
  )

const socketErrorToLlmError = (error: Socket.SocketError) =>
  new LLMError({
    cause: 'provider_error',
    message: `Codex WebSocket error: ${error.message}`,
    retryable: true,
    provider: codexProviderInfo({ kind: 'network' })
  })

const httpClientErrorToLlmError =
  (message: string, retryable: boolean) => (error: HttpClientError.HttpClientError) =>
    new LLMError({
      cause: 'provider_error',
      message: `${message}: ${error.message}`,
      retryable,
      provider: codexProviderInfo({ kind: retryable ? 'network' : 'unknown' })
    })

type CodexProxyHeaders = {
  readonly accept: string
  readonly authorization: string
  readonly 'content-type': string
  readonly originator: string
  'ChatGPT-Account-Id'?: string
}

const codexProxyHeaders = (config: CodexWsConfig) => {
  const headers: CodexProxyHeaders = {
    accept: 'application/json',
    authorization: `Bearer ${config.token.accessToken}`,
    'content-type': 'application/json',
    originator: 'opencode'
  }

  if (config.token.accountId !== undefined) {
    headers['ChatGPT-Account-Id'] = config.token.accountId
  }

  return headers
}

const sendCodexProxyRequest = (
  config: CodexWsConfig & { readonly fallback: CodexResponsesProxyConfig },
  request: LLMRequest,
  client: HttpClient.HttpClient
): Effect.Effect<HttpClientResponse.HttpClientResponse, LLMError> =>
  Effect.gen(function* () {
    const body = yield* toOpenAiCodexRequestBody(request, {})

    const serializedBody = yield* Schema.decodeUnknownEffect(Schema.Json)(body).pipe(
      Effect.mapError(schemaErrorToLlmError('Could not serialize Codex WS request')),
      Effect.flatMap(encodeJson)
    )

    const response = yield* client
      .execute(
        HttpClientRequest.post(config.fallback.endpoint).pipe(
          HttpClientRequest.setHeaders({
            ...codexProxyHeaders(config),
            'x-yolk-cloudflare-secret': config.fallback.bridgeSecret
          }),
          HttpClientRequest.bodyText(serializedBody, 'application/json')
        )
      )
      .pipe(Effect.mapError(httpClientErrorToLlmError('Codex proxy request failed', true)))

    if (response.status < 200 || response.status >= 300) {
      const errorText = yield* response.text.pipe(
        Effect.mapError(httpClientErrorToLlmError('Could not read Codex proxy error body', false))
      )

      return yield* Effect.fail(
        codexProviderError({
          message: `Codex proxy returned ${response.status}`,
          status: response.status,
          headers: response.headers,
          body: errorText
        })
      )
    }

    return response
  })

const makeCodexProxyProvider = (
  config: CodexWsConfig & { readonly fallback: CodexResponsesProxyConfig },
  client: HttpClient.HttpClient
) =>
  LLMProvider.of({
    stream: request =>
      Stream.fromEffect(sendCodexProxyRequest(config, request, client)).pipe(
        Stream.flatMap(streamOpenAiCodexResponse)
      )
  })

// ---------------------------------------------------------------------------
// Provider layer
// ---------------------------------------------------------------------------

/**
 * LLMProvider that streams Codex via WebSocket from Cloudflare Workers.
 *
 * Uses Effect `Socket.fromWebSocket` for the WS lifecycle. Each `stream`
 * call opens a scoped socket. A `Queue` bridges `socket.runString` messages
 * into a `Stream.fromQueue` for the agent loop consumer.
 *
 * `Stream.unwrap` handles the scoped setup; `acquireRelease` ensures the
 * connection closes when the stream completes, errors, or is interrupted.
 */
const makeDirectCodexWsProvider = (config: CodexWsConfig) =>
  LLMProvider.of({
    stream: (request: LLMRequest) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const body = yield* toWsRequestBody(request)

          const bodyJson = yield* Schema.decodeUnknownEffect(Schema.Json)(body).pipe(
            Effect.mapError(schemaErrorToLlmError('Could not serialize Codex WS request')),
            Effect.flatMap(encodeJson)
          )

          const socket = yield* makeCodexSocket(config).pipe(Effect.mapError(socketErrorToLlmError))
          const write = yield* socket.writer
          const queue = yield* Queue.unbounded<LLMEvent, LLMError>()

          const toolCallCount = yield* Ref.make(0)

          const handleMessage = (data: string) =>
            Effect.gen(function* () {
              const msg = parseWsJson(data)

              if (msg === undefined) return

              const count = yield* Ref.get(toolCallCount)
              const result = mapWsMessage(msg, count)

              yield* Match.value(result).pipe(
                Match.tag('Events', ({ events }) =>
                  Effect.gen(function* () {
                    const nextToolCalls = events.filter(e =>
                      Predicate.isTagged(e, 'ToolCall')
                    ).length

                    if (nextToolCalls > 0) {
                      yield* Ref.update(toolCallCount, current => current + nextToolCalls)
                    }

                    yield* Effect.forEach(events, event => Queue.offer(queue, event), {
                      discard: true
                    })
                  })
                ),
                Match.tag('Done', ({ events }) =>
                  Effect.gen(function* () {
                    yield* Effect.forEach(events, event => Queue.offer(queue, event), {
                      discard: true
                    })
                    yield* Queue.shutdown(queue)
                  })
                ),
                Match.tag('Error', ({ error }) => Queue.failCause(queue, Cause.fail(error))),
                Match.tag('Skip', () => Effect.void),
                Match.exhaustive
              )
            })

          // Fork socket runner: reads WS messages and pushes to queue.
          // When the socket closes/errors, shut down the queue so the
          // stream consumer terminates.
          const socketErrorToQueueFailure = (error: Socket.SocketError) =>
            Queue.failCause(queue, Cause.fail(socketErrorToLlmError(error)))

          yield* socket
            .runString(handleMessage, {
              onOpen: write(bodyJson).pipe(Effect.ignore)
            })
            .pipe(
              Effect.catchTag('SocketError', socketErrorToQueueFailure),
              Effect.ensuring(Queue.shutdown(queue)),
              Effect.forkScoped
            )

          return Stream.fromQueue(queue)
        })
      )
  })

const hasFallback = (
  config: CodexWsConfig
): config is CodexWsConfig & { readonly fallback: CodexResponsesProxyConfig } =>
  config.fallback !== undefined

export const makePreStreamFallbackProvider = (
  direct: LLMProviderImpl,
  fallback: LLMProviderImpl,
  onFallback: (error: LLMError) => void
) =>
  LLMProvider.of({
    stream: request =>
      Stream.unwrap(
        Ref.make(false).pipe(
          Effect.map(emittedEvent =>
            direct.stream(request).pipe(
              Stream.tap(() => Ref.set(emittedEvent, true)),
              Stream.catchTag('LLMError', error =>
                Stream.unwrap(
                  Ref.get(emittedEvent).pipe(
                    Effect.map(hasEmitted => {
                      if (hasEmitted) return Stream.fail(error)
                      onFallback(error)

                      return fallback.stream(request)
                    })
                  )
                )
              )
            )
          )
        )
      )
  })

export const makeCodexWsProviderLayer = (config: CodexWsConfig) =>
  hasFallback(config)
    ? Layer.effect(
        LLMProvider,
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient

          return makeCodexProxyProvider(config, client)
        })
      )
    : Layer.succeed(LLMProvider, makeDirectCodexWsProvider(config))
