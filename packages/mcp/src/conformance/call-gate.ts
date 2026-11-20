/**
 * The fail-closed call gate of the observing client (internal).
 *
 * A calling case wraps ONE client operation (`callRemoteMcpServerTool`, which lists and then
 * calls on one connection) in an observer with a `McpCallGate`. When that operation's `tools/call`
 * is about to be forwarded, `gateVerdict` decides from the exchanges the observer has seen since
 * the operation began. It forwards ONLY on positive evidence:
 *
 * 1. Every earlier exchange is fully understood (`isUnderstood`): a POST request answered 2xx with
 *    a complete JSON or SSE body (parsed with `JSON.parse` semantics) holding exactly one response
 *    to its id and otherwise only notifications; a notification answered 2xx (the SDK ignores the
 *    body); the era probe answered non-2xx (the transport classifies the HTTP error and dispatches
 *    no result), or answered 2xx (not 202) with a complete body holding only the probe's own
 *    response, notifications and error responses (any id, `null` included: an error cannot carry a
 *    listing); a GET answered non-2xx, or a GET whose bytes so far carry no data event. The probe
 *    does NOT only select the era: after the probe window closes, the rest of its stream reaches
 *    the client's protocol `onmessage`, so a `tools/list`-shaped response in its tail could resolve
 *    the listing. Anything else is uncertainty: a 202 answer to a request, a message delivered on a
 *    GET, an unparseable body, an unterminated stream, an unanswered request, two responses for
 *    one id, or an unknown shape. SSE bodies are read with the SDK's own parser (`sse.ts`).
 *    One server request is understood, and only with its whole round trip in view: a benign
 *    server ping (`isBenignPing`) in a POST's answer, answered once by a later client POST whose
 *    body is exactly the empty result to it (`jsonrpc`, `id` and `result: {}`), which the server
 *    accepted with 202 and an empty body. Any other server request, a ping with params, a ping not
 *    answered exactly once, or an answer without that acceptance (no status yet, a rejection, a
 *    body) stays uncertainty, as does any other client-sent response.
 *    Why a ping is safe (MCP `2025-11-25` basic/utilities/ping): it is a liveness check whose only
 *    defined answer is an empty result ("The receiver MUST respond promptly with an empty
 *    response"); the pinned SDK answers it with a handler that returns `{}` and touches no state
 *    (`Protocol` constructor). A ping is a request, not a response, so it resolves none of the
 *    client's requests and can carry no listing; the client's answer carries only the empty
 *    result, and its 202 without a body delivers nothing back. So the round trip changes neither
 *    what the client saw nor what the gate proves (#382). `2026-07-28` has no ping (changelog,
 *    major changes 5 and 7): this matters for legacy servers only. The gate decides when the
 *    call is about to be sent, from what it has recorded by then: a ping inside a `tools/list`
 *    answer is answered concurrently with the call, so it is understood only when its accepted
 *    answer was recorded before the call is gated; otherwise the gate refuses (it fails closed),
 *    so a live server that pings there can see occasional refusals.
 * 2. The operation's listing is complete: at least one `tools/list` page, each answered with a
 *    `result.tools` array, each page after the first sending the previous page's `nextCursor`,
 *    and the last page carrying no `nextCursor`.
 * 3. The call is the operation's first `tools/call` and names the gated tool, and: for `absent`,
 *    no listed tool has that name; for `read-only`, at least one listed tool has that name and
 *    every such entry is marked `annotations.readOnlyHint: true`.
 *
 * Anything else refuses (`McpCallRefusal`).
 *
 * @experimental
 */
import { Option, Predicate } from 'effect'
import { field, isJsonObject, parseWireJson, type Json, type JsonObject } from './json.ts'
import type { McpObservedExchange } from './observe.ts'
import { sseAllPayloads, sseMessagePayloads } from './sse.ts'

/** The parser feeds of an answer (see `McpObservedExchange.responseFeeds`). */
const feedsOf = (exchange: McpObservedExchange, body: string): ReadonlyArray<string> =>
  exchange.responseFeeds ?? [body]

/** What a calling case lets through: a call of an absent tool, or of a read-only tool. */
export type McpCallGate = {
  readonly kind: 'absent' | 'read-only'
  readonly name: string
}

/** Why the observer refused to forward a `tools/call`. */
export type McpCallRefusal =
  | 'uncertain-exchange'
  | 'incomplete-listing'
  | 'tool-listed'
  | 'tool-not-read-only'
  | 'unexpected-call'

const rpcMethodOf = (exchange: McpObservedExchange): string | undefined => {
  const method = field(exchange.requestBody, 'method')

  return Predicate.isString(method) ? method : undefined
}

const rpcIdOf = (exchange: McpObservedExchange): string | number | undefined => {
  const id = field(exchange.requestBody, 'id')

  return Predicate.isString(id) || Predicate.isNumber(id) ? id : undefined
}

const is2xx = (status: number | undefined) => status !== undefined && status >= 200 && status < 300

/** The JSON-RPC messages of a complete answer body, or `undefined` when any part is not JSON. */
const messagesOf = (
  exchange: McpObservedExchange,
  body: string
): ReadonlyArray<Json> | undefined => {
  const mediaType = exchange.mediaType

  if (mediaType === 'text/event-stream') {
    const parsed = sseMessagePayloads(feedsOf(exchange, body)).map(parseWireJson)

    return parsed.every(Option.isSome) ? parsed.flatMap(Option.toArray) : undefined
  }

  if (mediaType !== 'application/json') {
    return undefined
  }

  return Option.match(parseWireJson(body), {
    onNone: () => undefined,
    onSome: (value): ReadonlyArray<Json> => (Array.isArray(value) ? value : [value])
  })
}

const isNotification = (message: Json): boolean =>
  isJsonObject(message) && Predicate.isString(message['method']) && !('id' in message)

const isResponseTo = (message: Json, id: string | number): boolean =>
  isJsonObject(message) && message['id'] === id && ('result' in message || 'error' in message)

type RpcId = string | number

const isRpcId = (value: Json | undefined): value is RpcId =>
  Predicate.isString(value) || Predicate.isNumber(value)

const isEmptyObject = (value: Json | undefined): boolean =>
  isJsonObject(value) && Object.keys(value).length === 0

/**
 * A benign server ping (see the module doc, rule 1): a JSON-RPC request with only the members
 * `jsonrpc: "2.0"`, a string or number `id`, `method: "ping"`, and optionally empty `params`.
 */
const isBenignPing = (message: Json): message is JsonObject =>
  isJsonObject(message) &&
  Object.keys(message).every(key => ['jsonrpc', 'id', 'method', 'params'].includes(key)) &&
  message['jsonrpc'] === '2.0' &&
  isRpcId(message['id']) &&
  message['method'] === 'ping' &&
  (!('params' in message) || isEmptyObject(message['params']))

/** An error response, whatever its id (`null` included): it cannot carry a listing. */
const isErrorResponse = (message: Json): boolean =>
  isJsonObject(message) && 'error' in message && !('result' in message) && !('method' in message)

/** Whether the era probe's answer is fully understood (see the module doc, rule 1). */
const isUnderstoodProbe = (exchange: McpObservedExchange): boolean => {
  const id = rpcIdOf(exchange)
  const body = exchange.responseBody

  if (exchange.status === undefined || body === undefined || id === undefined) {
    return false
  }

  if (!is2xx(exchange.status)) {
    return true
  }

  if (exchange.status === 202) {
    return false
  }

  const messages = messagesOf(exchange, body)

  return (
    messages !== undefined &&
    messages.every(
      message => isResponseTo(message, id) || isNotification(message) || isErrorResponse(message)
    )
  )
}

/** The single response to the exchange's request in its complete answer, else `undefined`. */
const soleResponse = (exchange: McpObservedExchange): JsonObject | undefined => {
  const id = rpcIdOf(exchange)
  const body = exchange.responseBody

  if (
    id === undefined ||
    body === undefined ||
    !is2xx(exchange.status) ||
    exchange.status === 202
  ) {
    return undefined
  }

  const messages = messagesOf(exchange, body)

  if (messages === undefined) {
    return undefined
  }

  const responses = messages.filter(message => isResponseTo(message, id))
  const [response] = responses

  // A benign ping counts only with its accepted answer (`pingsSettled`).
  return responses.length === 1 &&
    messages.every(
      message => isResponseTo(message, id) || isNotification(message) || isBenignPing(message)
    ) &&
    isJsonObject(response)
    ? response
    : undefined
}

/**
 * The ids of the benign pings in the answer to a POST request other than the era probe (the only
 * answers `soleResponse` reads them in; elsewhere a ping stays uncertainty).
 */
const pingIdsOf = (exchange: McpObservedExchange): ReadonlyArray<RpcId> => {
  const method = rpcMethodOf(exchange)
  const body = exchange.responseBody

  if (
    exchange.method !== 'POST' ||
    method === undefined ||
    method === 'server/discover' ||
    rpcIdOf(exchange) === undefined ||
    body === undefined
  ) {
    return []
  }

  return (messagesOf(exchange, body) ?? []).flatMap(message => {
    const id = isBenignPing(message) ? message['id'] : undefined

    return isRpcId(id) ? [id] : []
  })
}

/** The id a POST answers when its body is exactly the empty result to a request, else none. */
const pingAnswerIdOf = (exchange: McpObservedExchange): RpcId | undefined => {
  const body = exchange.requestBody
  const id = field(body, 'id')

  return exchange.method === 'POST' &&
    isJsonObject(body) &&
    Object.keys(body).length === 3 &&
    body['jsonrpc'] === '2.0' &&
    isEmptyObject(body['result']) &&
    isRpcId(id)
    ? id
    : undefined
}

/**
 * Whether every benign ping in `earlier` was answered exactly once, after it, with the empty
 * result, and the server accepted that answer with 202 and an empty body; and whether every such
 * answer answers exactly one of those pings (see the module doc, rule 1).
 */
const pingsSettled = (earlier: ReadonlyArray<McpObservedExchange>): boolean => {
  const pings = earlier.flatMap((exchange, index) => pingIdsOf(exchange).map(id => ({ id, index })))

  const answers = earlier.flatMap((exchange, index) => {
    const id = pingAnswerIdOf(exchange)

    return id === undefined ? [] : [{ id, index, exchange }]
  })

  return (
    pings.every(ping => {
      const matching = answers.filter(answer => answer.id === ping.id)
      const [answer] = matching

      return (
        matching.length === 1 &&
        answer !== undefined &&
        answer.index > ping.index &&
        answer.exchange.status === 202 &&
        answer.exchange.responseBody === ''
      )
    }) && answers.every(answer => pings.filter(ping => ping.id === answer.id).length === 1)
  )
}

/** Whether the SDK's view of `exchange` is fully accounted for (see the module doc, rule 1). */
const isUnderstood = (
  exchange: McpObservedExchange,
  receivedSoFar: ReadonlyArray<string> | undefined
): boolean => {
  if (exchange.method === 'GET') {
    if (exchange.status !== undefined && !is2xx(exchange.status)) {
      return true
    }

    const feeds =
      exchange.responseBody === undefined
        ? (receivedSoFar ?? [])
        : feedsOf(exchange, exchange.responseBody)

    return sseAllPayloads(feeds).length === 0
  }

  if (exchange.method !== 'POST' || !isJsonObject(exchange.requestBody)) {
    return false
  }

  const method = rpcMethodOf(exchange)

  if (method === undefined) {
    return false
  }

  if (rpcIdOf(exchange) === undefined) {
    return is2xx(exchange.status)
  }

  if (method === 'server/discover') {
    return isUnderstoodProbe(exchange)
  }

  return soleResponse(exchange) !== undefined
}

type Listing =
  | { readonly kind: 'complete'; readonly tools: ReadonlyArray<Json> }
  | { readonly kind: 'incomplete' }

/** The operation's listing (rule 2). */
const listingOf = (exchanges: ReadonlyArray<McpObservedExchange>): Listing => {
  const pages = exchanges.filter(
    exchange => exchange.method === 'POST' && rpcMethodOf(exchange) === 'tools/list'
  )

  const tools: Array<Json> = []
  let previous: Json | undefined

  if (pages.length === 0) {
    return { kind: 'incomplete' }
  }

  for (const [index, page] of pages.entries()) {
    const cursor = field(field(page.requestBody, 'params'), 'cursor')
    const result = field(soleResponse(page), 'result')
    const listed = field(result, 'tools')

    if ((index === 0 ? cursor !== undefined : cursor !== previous) || !Array.isArray(listed)) {
      return { kind: 'incomplete' }
    }

    tools.push(...listed)
    previous = field(result, 'nextCursor')
  }

  return previous === undefined ? { kind: 'complete', tools } : { kind: 'incomplete' }
}

/**
 * Whether to forward the `tools/call` in `call`, given the exchanges seen before it in the same
 * operation and, for streams still open, the bytes received so far (by exchange index).
 */
export const gateVerdict = (
  gate: McpCallGate,
  call: McpObservedExchange,
  earlier: ReadonlyArray<McpObservedExchange>,
  receivedSoFar: (index: number) => ReadonlyArray<string> | undefined
): McpCallRefusal | undefined => {
  if (
    field(field(call.requestBody, 'params'), 'name') !== gate.name ||
    earlier.some(exchange => rpcMethodOf(exchange) === 'tools/call')
  ) {
    return 'unexpected-call'
  }

  // A client answer to a ping is understood only through `pingsSettled`, which pairs it with its
  // ping; every other exchange must be understood on its own.
  if (
    !earlier.every(
      (exchange, index) =>
        pingAnswerIdOf(exchange) !== undefined || isUnderstood(exchange, receivedSoFar(index))
    ) ||
    !pingsSettled(earlier)
  ) {
    return 'uncertain-exchange'
  }

  const listing = listingOf(earlier)

  if (listing.kind === 'incomplete') {
    return 'incomplete-listing'
  }

  const named = listing.tools.filter(tool => field(tool, 'name') === gate.name)

  if (gate.kind === 'absent') {
    return named.length === 0 ? undefined : 'tool-listed'
  }

  return named.length > 0 &&
    named.every(tool => field(field(tool, 'annotations'), 'readOnlyHint') === true)
    ? undefined
    : 'tool-not-read-only'
}
