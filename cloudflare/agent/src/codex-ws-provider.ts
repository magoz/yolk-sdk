import { Cause, Effect, Layer, Queue, Ref, Stream } from 'effect'
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
import { AgentInputUsage, AgentOutputUsage, AgentUsage, ToolCall } from '@yolk-sdk/agent/protocol'
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const getString = (obj: Record<string, unknown>, key: string): string | undefined => {
  const v = obj[key]
  return typeof v === 'string' ? v : undefined
}

const getNumber = (obj: Record<string, unknown>, key: string): number | undefined => {
  const v = obj[key]
  return typeof v === 'number' ? v : undefined
}

const getRecord = (
  obj: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined => {
  const v = obj[key]
  return isRecord(v) ? v : undefined
}

const parseWsJson = (text: string): Record<string, unknown> | undefined => {
  const parsed = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
  )
  return isRecord(parsed) ? parsed : undefined
}

const encodeJson = (value: unknown) =>
  Schema.encodeUnknownEffect(Schema.UnknownFromJsonString)(value).pipe(
    Effect.mapError(
      error =>
        new LLMError({
          cause: 'provider_error',
          message: `Could not serialize Codex WS request: ${error.message}`,
          retryable: false
        })
    )
  )

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export const toWsRequestBody = (request: LLMRequest) =>
  toOpenAiCodexRequestBody(request).pipe(
    Effect.map(body => ({ type: 'response.create' as const, ...body }))
  )

export const codexWsHeaders = (config: CodexWsConfig): Record<string, string> => {
  const headers: Record<string, string> = {
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

const parseToolCall = (item: Record<string, unknown>): LLMToolCall | undefined => {
  if (getString(item, 'type') !== 'function_call') return undefined
  const callId = getString(item, 'call_id')
  const name = getString(item, 'name')
  const args = getString(item, 'arguments')
  if (callId === undefined || name === undefined || args === undefined) return undefined

  const decoded = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(args)
  )
  return LLMToolCall.make({
    call: ToolCall.make({ id: callId, name, params: decoded ?? args })
  })
}

const parseUsage = (response: Record<string, unknown>): LLMUsage | undefined => {
  const usage = getRecord(response, 'usage')
  if (usage === undefined) return undefined

  const inputTokens = getNumber(usage, 'input_tokens') ?? 0
  const outputTokens = getNumber(usage, 'output_tokens') ?? 0
  const inputDetails = getRecord(usage, 'input_tokens_details')
  const outputDetails = getRecord(usage, 'output_tokens_details')

  return LLMUsage.make({
    usage: AgentUsage.make({
      input: AgentInputUsage.make({
        total: inputTokens,
        uncached:
          inputTokens -
          (inputDetails !== undefined ? (getNumber(inputDetails, 'cached_tokens') ?? 0) : 0),
        cacheRead: inputDetails !== undefined ? getNumber(inputDetails, 'cached_tokens') : undefined
      }),
      output: AgentOutputUsage.make({
        total: outputTokens,
        reasoning:
          outputDetails !== undefined ? getNumber(outputDetails, 'reasoning_tokens') : undefined,
        text:
          outputTokens -
          (outputDetails !== undefined ? (getNumber(outputDetails, 'reasoning_tokens') ?? 0) : 0)
      })
    })
  })
}

const stopReasonFromCompleted = (
  response: Record<string, unknown>,
  streamedToolCalls: number
): 'stop' | 'tool_use' => {
  if (streamedToolCalls > 0) return 'tool_use'

  const output = response.output
  if (!Array.isArray(output)) return 'stop'

  for (const item of output) {
    if (isRecord(item) && getString(item, 'type') === 'function_call') {
      return 'tool_use'
    }
  }

  return 'stop'
}

export const mapWsMessage = (
  msg: Record<string, unknown>,
  streamedToolCallCount: number
): WsResult => {
  const type = getString(msg, 'type')

  switch (type) {
    case 'response.output_text.delta':
    case 'response.content_part.delta': {
      const delta = getString(msg, 'delta')
      if (delta === undefined) return { _tag: 'Skip' }
      return { _tag: 'Events', events: [LLMTextDelta.make({ text: delta })] }
    }

    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta': {
      const delta = getString(msg, 'delta')
      if (delta === undefined) return { _tag: 'Skip' }
      return { _tag: 'Events', events: [LLMReasoningDelta.make({ text: delta })] }
    }

    case 'response.output_item.done': {
      const item = getRecord(msg, 'item')
      if (item === undefined) return { _tag: 'Skip' }
      const toolCall = parseToolCall(item)
      if (toolCall === undefined) return { _tag: 'Skip' }
      return { _tag: 'Events', events: [toolCall] }
    }

    case 'response.completed': {
      const response = getRecord(msg, 'response')
      if (response === undefined) {
        return { _tag: 'Done', events: [LLMDone.make({ stopReason: 'stop' })] }
      }

      const stopReason = stopReasonFromCompleted(response, streamedToolCallCount)
      const events: Array<LLMEvent> = [LLMDone.make({ stopReason })]
      const usage = parseUsage(response)
      if (usage !== undefined) events.push(usage)
      return { _tag: 'Done', events }
    }

    case 'response.failed': {
      const response = getRecord(msg, 'response')
      const error = response !== undefined ? getRecord(response, 'error') : undefined
      const message =
        error !== undefined
          ? (getString(error, 'message') ?? 'Codex response failed')
          : 'Codex response failed'

      return {
        _tag: 'Error',
        error: new LLMError({ cause: 'provider_error', message, retryable: false })
      }
    }

    case 'error': {
      const error = getRecord(msg, 'error')
      const message =
        error !== undefined
          ? (getString(error, 'message') ?? 'Codex WebSocket error')
          : 'Codex WebSocket error'
      const code = error !== undefined ? getString(error, 'code') : undefined

      return {
        _tag: 'Error',
        error: new LLMError({
          cause: code === 'rate_limit' ? 'rate_limit' : 'provider_error',
          message,
          retryable: code === 'rate_limit'
        })
      }
    }

    default:
      return { _tag: 'Skip' }
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
// Use property descriptor to avoid type-level conflicts between DOM
// Response and Workers Response.
const isWebSocketLike = (ws: unknown): ws is WebSocket =>
  typeof ws === 'object' && ws !== null && 'send' in ws && 'close' in ws

const getWorkersWebSocket = (response: Response): WebSocket | undefined => {
  if (!('webSocket' in response)) return undefined

  const ws: unknown = Reflect.get(response, 'webSocket')
  if (ws === null || ws === undefined) return undefined
  return isWebSocketLike(ws) ? ws : undefined
}

const logCodexWs = (event: string, data: Record<string, unknown>) => {
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
      if ('accept' in ws && typeof ws.accept === 'function') {
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
    retryable: true
  })

const httpClientErrorToLlmError =
  (message: string, retryable: boolean) => (error: HttpClientError.HttpClientError) =>
    new LLMError({
      cause: 'provider_error',
      message: `${message}: ${error.message}`,
      retryable
    })

const responseStatusToCause = (status: number): LLMError['cause'] => {
  if (status === 429) return 'rate_limit'
  if (status === 413) return 'context_overflow'
  return 'provider_error'
}

const isRetryableStatus = (status: number) => status === 429 || status >= 500

const codexProxyHeaders = (config: CodexWsConfig): Record<string, string> => {
  const headers: Record<string, string> = {
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
    const body = yield* toOpenAiCodexRequestBody(request)
    const serializedBody = yield* encodeJson(body)
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
        new LLMError({
          cause: responseStatusToCause(response.status),
          message: `Codex proxy returned ${response.status}: ${errorText}`,
          retryable: isRetryableStatus(response.status)
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
          const bodyJson = yield* encodeJson(body)
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

              switch (result._tag) {
                case 'Events': {
                  const nextToolCalls = result.events.filter(e => e._tag === 'ToolCall').length
                  if (nextToolCalls > 0) {
                    yield* Ref.update(toolCallCount, current => current + nextToolCalls)
                  }
                  yield* Effect.forEach(result.events, event => Queue.offer(queue, event), {
                    discard: true
                  })
                  break
                }
                case 'Done': {
                  yield* Effect.forEach(result.events, event => Queue.offer(queue, event), {
                    discard: true
                  })
                  yield* Queue.shutdown(queue)
                  break
                }
                case 'Error':
                  yield* Queue.failCause(queue, Cause.fail(result.error))
                  break
                case 'Skip':
                  break
              }
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
