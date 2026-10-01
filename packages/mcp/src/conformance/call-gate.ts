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

  return responses.length === 1 &&
    messages.every(message => isResponseTo(message, id) || isNotification(message)) &&
    isJsonObject(response)
    ? response
    : undefined
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

  if (!earlier.every((exchange, index) => isUnderstood(exchange, receivedSoFar(index)))) {
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
