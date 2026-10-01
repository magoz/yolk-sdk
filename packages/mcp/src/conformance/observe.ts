/**
 * The observing `HttpClient` the MCP conformance cases wrap around the host's client.
 *
 * It forwards requests unchanged and never sends a request of its own. It records each exchange
 * for the case to inspect: method, URL, allowlisted request and response headers, the parsed JSON
 * request body, status, media type, and the whole response body once the caller has read it.
 *
 * Its guarantees are exactly these:
 *
 * - It never keeps `authorization` or any other credential-named header: only the allowlisted
 *   MCP routing headers (`mcpObservedRequestHeaders`, `mcpObservedResponseHeaders`) are copied.
 * - It never keeps the URL query or fragment: only origin and path.
 * - It never keeps a raw `mcp-session-id` header value: only `McpObservedSession` evidence (an
 *   equality class such as `session#1`, assigned through a SHA-256 digest, and whether the value
 *   is visible ASCII).
 * - Request and response bodies are kept exactly as received. They may reflect anything a server
 *   echoes, credentials and session ids included, so they are sensitive: in memory only, never
 *   logged or persisted. Persisted or printed output is the live runner's job (its redacting IO
 *   and staging guards), not the observer's.
 *
 * With a `callGate`, the observer may also REFUSE to forward a `tools/call` (it still never sends a
 * request of its own). The gate is a fail-closed allowlist (`call-gate.ts`): the call is forwarded
 * only when everything this observer saw since the operation began is fully understood, the
 * operation's own listing is complete, and that listing proves the call safe (the absent tool is
 * not listed; the read tool is marked `readOnlyHint: true`). Otherwise the call is answered
 * locally with a transport failure and recorded with its `refused` reason. Answers are read with
 * `JSON.parse` semantics, as the SDK reads them.
 *
 * @experimental
 */
import { Effect, Exit, Option, Predicate, Ref, Stream } from 'effect'
import type * as Schema from 'effect/Schema'
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse
} from 'effect/unstable/http'
import { gateVerdict, type McpCallGate, type McpCallRefusal } from './call-gate.ts'
import { field, parseWireJson, type Json } from './json.ts'
import { decodeAsTextDecoderStream, sseAllPayloads } from './sse.ts'

export type { McpCallGate, McpCallRefusal } from './call-gate.ts'

/** Request headers the observer keeps (MCP routing headers; never credentials or sessions). */
export const mcpObservedRequestHeaders: ReadonlyArray<string> = [
  'accept',
  'content-type',
  'last-event-id',
  'mcp-method',
  'mcp-name',
  'mcp-protocol-version'
]

/** Response headers the observer keeps (never credentials or sessions). */
export const mcpObservedResponseHeaders: ReadonlyArray<string> = [
  'content-type',
  'www-authenticate'
]

const sessionHeader = 'mcp-session-id'

/** Lower-case header name to value: only allowlisted headers, never a credential. */
export type McpObservedHeaders = Readonly<Record<string, string>>

/**
 * Evidence about one `mcp-session-id` value, without the value: `id` is its equality class within
 * one observer (`session#1`, `session#2`, ... in order of first sight), so an echo check compares
 * classes.
 */
export type McpObservedSession = {
  readonly id: string
  /** Every character is visible ASCII (0x21 to 0x7E), as the MCP transport requires. */
  readonly visibleAscii: boolean
}

/** One observed exchange, in the order the client sent the requests. */
export type McpObservedExchange = {
  readonly method: string
  /** Origin and path of the request URL (query and fragment dropped). */
  readonly url: string
  readonly requestHeaders: McpObservedHeaders
  /** The `mcp-session-id` the request carried, as evidence only. */
  readonly requestSession?: McpObservedSession
  /** The request body parsed as JSON; absent when there is none or it is not JSON. */
  readonly requestBody?: Schema.Json
  /** Why the observer refused to forward this request (`callGate`); it then has no answer. */
  readonly refused?: McpCallRefusal
  /** Absent while the request has no answer (or never got one before the client closed). */
  readonly status?: number
  readonly responseHeaders?: McpObservedHeaders
  /** The `mcp-session-id` the answer carried, as evidence only. */
  readonly responseSession?: McpObservedSession
  /** Lower-case media type of the answer (`content-type` without parameters). */
  readonly mediaType?: string
  /** The whole answer body as received; absent until the caller has read it all. Sensitive. */
  readonly responseBody?: string
  /**
   * The same body as the text chunks `TextDecoderStream` emits for it (the streaming decode, then
   * the flush when non-empty): the separate parser feeds the client's SSE reader gets. Set
   * together with `responseBody`, whose text they concatenate to. Sensitive.
   */
  readonly responseFeeds?: ReadonlyArray<string>
}

/** The parser feeds of an exchange's answer (its `responseFeeds`, else its body as one feed). */
export const mcpResponseFeeds = (exchange: McpObservedExchange): ReadonlyArray<string> =>
  exchange.responseFeeds ?? (exchange.responseBody === undefined ? [] : [exchange.responseBody])

export type McpObservingOptions = {
  /**
   * Gate the operation's `tools/call`: forward it only on positive evidence from the same
   * operation (see `call-gate.ts`); refuse otherwise.
   */
  readonly callGate?: McpCallGate
}

export type McpObservingHttpClient = {
  readonly client: HttpClient.HttpClient
  /** Every exchange so far, in request order. Sensitive: never log or persist it. */
  readonly exchanges: Effect.Effect<ReadonlyArray<McpObservedExchange>>
}

const nullBodyStatuses: ReadonlySet<number> = new Set([101, 103, 204, 205, 304])

/** `content-type` without parameters, lower-cased. */
export const mcpMediaType = (contentType: string | undefined): string | undefined =>
  contentType?.split(';', 1)[0]?.trim().toLowerCase()

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0

  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }

  return joined
}

const requestUrl = (request: HttpClientRequest.HttpClientRequest): string =>
  Option.match(HttpClientRequest.toUrl(request), {
    onNone: () => request.url.split(/[?#]/, 1)[0] ?? request.url,
    onSome: url => `${url.origin}${url.pathname}`
  })

const requestBodyText = (request: HttpClientRequest.HttpClientRequest): string | undefined => {
  const body = request.body

  if (Predicate.isTagged(body, 'Uint8Array')) {
    return new TextDecoder().decode(body.body)
  }

  return Predicate.isTagged(body, 'Raw') && Predicate.isString(body.body) ? body.body : undefined
}

const digest = (value: string) =>
  Effect.promise(() => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).pipe(
    Effect.map(bytes =>
      Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
    )
  )

const jsonRpcMethod = (body: Option.Option<Json>): string | undefined => {
  const method = Option.isSome(body) ? field(body.value, 'method') : undefined

  return Predicate.isString(method) ? method : undefined
}

/** Every JSON value in an answer: the whole JSON body, or every dispatched SSE data payload. */
const answerValues = (exchange: McpObservedExchange): ReadonlyArray<Json> =>
  (exchange.mediaType === 'text/event-stream'
    ? sseAllPayloads(mcpResponseFeeds(exchange))
    : [exchange.responseBody ?? '']
  ).flatMap(payload =>
    Option.match(parseWireJson(payload), {
      onNone: () => [],
      onSome: (value): ReadonlyArray<Json> => (Array.isArray(value) ? value : [value])
    })
  )

/** The tool names in raw answer values (every `result.tools[].name`, before any filtering). */
const toolNamesIn = (values: ReadonlyArray<Json>): ReadonlyArray<string> =>
  values.flatMap(value => {
    const tools = field(field(value, 'result'), 'tools')

    return Array.isArray(tools)
      ? tools.flatMap(tool => {
          const name = field(tool, 'name')

          return Predicate.isString(name) ? [name] : []
        })
      : []
  })

/**
 * Every tool name in any answer carrying `result.tools` among `exchanges` (internal), whichever
 * request it answers (GET included): every JSON value of each answer (every dispatched SSE event,
 * whatever its type), parsed as `JSON.parse` parses it, before the SDK filters anything.
 */
export const rawListedToolNames = (
  exchanges: ReadonlyArray<McpObservedExchange>
): ReadonlyArray<string> =>
  exchanges.flatMap(exchange =>
    exchange.responseBody === undefined ? [] : toolNamesIn(answerValues(exchange))
  )

/**
 * Wrap `upstream` so every exchange is observed. Event streams are teed chunk by chunk (the caller
 * reads them exactly as before, and a stream that never ends is never waited for); other bodies
 * are read once and handed on as the same bytes.
 */
export const makeMcpObservingHttpClient = (
  upstream: HttpClient.HttpClient,
  options: McpObservingOptions = {}
): Effect.Effect<McpObservingHttpClient> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<ReadonlyArray<McpObservedExchange>>([])
    // Digest of a session value to its class; the raw value is never kept.
    const sessions = yield* Ref.make<ReadonlyMap<string, string>>(new Map())
    // Bytes received so far on each still-open event stream, by exchange index (for the gate).
    const openStreams = new Map<number, Array<Uint8Array>>()

    // Parser feeds of the bytes received so far (the decoder has not flushed: the stream is open).
    const receivedSoFar = (index: number): ReadonlyArray<string> | undefined => {
      const chunks = openStreams.get(index)

      return chunks === undefined ? undefined : decodeAsTextDecoderStream(concat(chunks), false)
    }

    const allowlisted = (
      headers: Readonly<Record<string, string | undefined>>,
      allowlist: ReadonlyArray<string>
    ): McpObservedHeaders =>
      Object.fromEntries(
        Object.entries(headers).flatMap(([name, value]) => {
          const lower = name.toLowerCase()

          return value !== undefined && allowlist.includes(lower) ? [[lower, value]] : []
        })
      )

    const sessionOf = (headers: Readonly<Record<string, string | undefined>>) =>
      Effect.gen(function* () {
        const value = Object.entries(headers).find(
          ([name]) => name.toLowerCase() === sessionHeader
        )?.[1]

        if (value === undefined) {
          return undefined
        }

        const key = yield* digest(value)

        const id = yield* Ref.modify(sessions, (current): [string, ReadonlyMap<string, string>] => {
          const known = current.get(key)

          if (known !== undefined) {
            return [known, current]
          }

          const label = `session#${current.size + 1}`

          return [label, new Map([...current, [key, label]])]
        })

        const session: McpObservedSession = { id, visibleAscii: /^[\x21-\x7E]+$/.test(value) }

        return session
      })

    const record = (exchange: McpObservedExchange) =>
      Ref.modify(state, (current): [number, ReadonlyArray<McpObservedExchange>] => [
        current.length,
        [...current, exchange]
      ])

    const update = (index: number, f: (exchange: McpObservedExchange) => McpObservedExchange) =>
      Ref.update(state, current =>
        current.map((exchange, at) => (at === index ? f(exchange) : exchange))
      )

    const client = HttpClient.transform(
      upstream,
      (
        effect: Effect.Effect<
          HttpClientResponse.HttpClientResponse,
          HttpClientError.HttpClientError
        >,
        request
      ) =>
        Effect.gen(function* () {
          const text = requestBodyText(request)
          const body = text === undefined ? Option.none<Json>() : parseWireJson(text)
          const rpcMethod = jsonRpcMethod(body)
          const requestSession = yield* sessionOf(request.headers)

          const sent: McpObservedExchange = {
            method: request.method,
            url: requestUrl(request),
            requestHeaders: allowlisted(request.headers, mcpObservedRequestHeaders)
          }

          const withSession = requestSession === undefined ? sent : { ...sent, requestSession }

          const withBody = Option.isSome(body)
            ? { ...withSession, requestBody: body.value }
            : withSession

          const refused =
            options.callGate !== undefined && rpcMethod === 'tools/call'
              ? gateVerdict(options.callGate, withBody, yield* Ref.get(state), receivedSoFar)
              : undefined

          if (refused !== undefined) {
            yield* record({ ...withBody, refused })

            return yield* new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                description: `the observer refused to forward tools/call (${refused})`
              })
            })
          }

          const index = yield* record(withBody)
          const response = yield* effect
          const mediaType = mcpMediaType(response.headers['content-type'])
          const responseSession = yield* sessionOf(response.headers)

          yield* update(index, exchange => {
            const answered: McpObservedExchange = {
              ...exchange,
              status: response.status,
              responseHeaders: allowlisted(response.headers, mcpObservedResponseHeaders)
            }

            const withMedia = mediaType === undefined ? answered : { ...answered, mediaType }

            return responseSession === undefined ? withMedia : { ...withMedia, responseSession }
          })

          const init = { status: response.status, headers: response.headers }

          const settle = (bytes: Uint8Array) =>
            update(index, exchange => {
              const responseFeeds = decodeAsTextDecoderStream(bytes, true)

              return { ...exchange, responseBody: responseFeeds.join(''), responseFeeds }
            })

          if (mediaType === 'text/event-stream') {
            const chunks: Array<Uint8Array> = []

            openStreams.set(index, chunks)

            const teed = response.stream.pipe(
              Stream.tap(bytes => Effect.sync(() => chunks.push(bytes))),
              Stream.onExit(exit => (Exit.isSuccess(exit) ? settle(concat(chunks)) : Effect.void))
            )

            const readable = Stream.toReadableStream(teed, { strategy: { highWaterMark: 0 } })

            return HttpClientResponse.fromWeb(request, new Response(readable, init))
          }

          const bytes = new Uint8Array(yield* response.arrayBuffer)

          yield* settle(bytes)

          return HttpClientResponse.fromWeb(
            request,
            new Response(nullBodyStatuses.has(response.status) ? null : bytes, init)
          )
        })
    )

    return { client, exchanges: Ref.get(state) }
  })
