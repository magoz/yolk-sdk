/**
 * The call gate's server-ping rule as a property (#382): over generated call operations (pings and
 * other server messages in the `initialize` and listing answers, ping shapes, id kinds and repeats,
 * and the client's answers with their order, status, body, members and session), whenever the gate
 * forwards the call, every message the client read in an answer is a response to that answer's own
 * request, a notification, or a param-less ping with exactly one later client answer that holds
 * only the empty result, was accepted with 202 and an empty body, and carries the ping's session;
 * and every client-sent response answers such a ping. Generation is Effect's `Arbitrary` (the
 * repository's property tool; `patterns/SIMULATION_PROPERTY_TESTING.md`).
 */
import { isDeepStrictEqual } from 'node:util'
import { Arbitrary, Effect, Option, Predicate, Schema } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { gateVerdict, type McpCallGate } from '../../src/conformance/call-gate.ts'
import {
  mcpConformanceDiscoverRequestId,
  mcpConformanceLegacyInitializeResult,
  mcpConformanceSyntheticLegacyUrl,
  mcpConformanceSyntheticReadCall,
  mcpConformanceSyntheticTools
} from '../../src/conformance/index.ts'
import { parseWireJson, type Json, type JsonObject } from '../../src/conformance/json.ts'
import type { McpObservedExchange, McpObservedSession } from '../../src/conformance/observe.ts'
import { sseMessagePayloads } from '../../src/conformance/sse.ts'
import { propertyOptionsWith } from './property-options.ts'

// Gate verdicts are cheap and pure, so the default run count is higher than the agent package's.
const propertyOptions = propertyOptionsWith(3000)

const PingId = Schema.Literals(['a', 'b', 'seven'])

const Where = Schema.Literals(['initialize', 'listing'])

/** One server ping and the client's answer to it; `malformed` / `answerPerturbed` pick a flaw. */
const Ping = Schema.Struct({
  id: PingId,
  where: Where,
  emptyParams: Schema.Boolean,
  malformed: Schema.Boolean,
  malformation: Schema.Literals([
    'params',
    'meta-params',
    'null-params',
    'extra-member',
    'no-jsonrpc',
    'Ping',
    'roots/list'
  ]),
  answerPerturbed: Schema.Boolean,
  answer: Schema.Literals([
    'missing',
    'in-flight',
    'rejected',
    'status-200',
    'bodied',
    'other-session',
    'no-session',
    'twice',
    'early',
    'non-empty-result',
    'error',
    'extra-member',
    'other-id'
  ])
})

type Ping = typeof Ping.Type

/** Another server message in an answer, or a client response that answers no ping. */
const Noise = Schema.Struct({
  where: Where,
  kind: Schema.Literals([
    'notification',
    'stray-response',
    'duplicate-own-response',
    'stray-answer'
  ])
})

type Noise = typeof Noise.Type

// Test-budget cap: a few pings and noise messages per operation, so that operations whose only
// flaw is one generated perturbation (the ones a gate bug would forward) are reached often. Longer
// operations almost always carry several flaws; stress with a large `PROPERTY_RUNS`.
const Script = Schema.Struct({
  pings: Schema.Array(Ping).check(Schema.isMaxLength(3)),
  noise: Schema.Array(Noise).check(Schema.isMaxLength(2))
})

type Script = typeof Script.Type

const session1: McpObservedSession = { id: 'session#1', visibleAscii: true }

const session2: McpObservedSession = { id: 'session#2', visibleAscii: true }

const url = mcpConformanceSyntheticLegacyUrl

const gate: McpCallGate = { kind: 'read-only', name: mcpConformanceSyntheticReadCall.name }

const rpcId = (id: typeof PingId.Type): string | number =>
  id === 'seven' ? 7 : `server-ping-${id}`

const pingMessage = (ping: Ping): JsonObject => {
  const base = { jsonrpc: '2.0', id: rpcId(ping.id), method: 'ping' }
  const plain = ping.emptyParams ? { ...base, params: {} } : base

  if (!ping.malformed) {
    return plain
  }

  switch (ping.malformation) {
    case 'params':
      return { ...base, params: { reason: 'synthetic' } }
    case 'meta-params':
      return { ...base, params: { _meta: {} } }
    case 'null-params':
      return { ...base, params: null }
    case 'extra-member':
      return { ...plain, result: {} }
    case 'no-jsonrpc':
      return { id: rpcId(ping.id), method: 'ping' }
    case 'Ping':
      return { ...plain, method: 'Ping' }
    case 'roots/list':
      return { ...plain, method: 'roots/list' }
  }
}

const post = (
  requestBody: Json,
  answer?: { readonly status: number; readonly body: string; readonly sse?: boolean }
): McpObservedExchange => {
  const sent: McpObservedExchange = { method: 'POST', url, requestHeaders: {}, requestBody }

  if (answer === undefined) {
    return sent
  }

  const answered = { ...sent, status: answer.status, responseBody: answer.body }

  return answer.sse === true ? { ...answered, mediaType: 'text/event-stream' } : answered
}

const withSession = (
  exchange: McpObservedExchange,
  sessions: { readonly request?: McpObservedSession; readonly response?: McpObservedSession }
): McpObservedExchange => {
  const sent =
    sessions.request === undefined ? exchange : { ...exchange, requestSession: sessions.request }

  return sessions.response === undefined ? sent : { ...sent, responseSession: sessions.response }
}

const sse = (messages: ReadonlyArray<Json>) =>
  messages.map(message => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join('')

/** How the client's answer to a ping looks on the wire, and how many copies were sent. */
type ClientAnswer = {
  readonly body: Json
  readonly answer?: { readonly status: number; readonly body: string }
  readonly session?: McpObservedSession
  readonly copies: number
}

/** The answer `flaw` makes of the plain one (`early` is a placement, made by `operation`). */
const perturbed = (
  flaw: Ping['answer'],
  plain: ClientAnswer,
  id: string | number
): ClientAnswer => {
  switch (flaw) {
    case 'missing':
      return { ...plain, copies: 0 }
    case 'in-flight':
      return { body: plain.body, session: session1, copies: 1 }
    case 'rejected':
      return { ...plain, answer: { status: 400, body: '' } }
    case 'status-200':
      return { ...plain, answer: { status: 200, body: '' } }
    case 'bodied':
      return { ...plain, answer: { status: 202, body: '{}' } }
    case 'other-session':
      return { ...plain, session: session2 }
    case 'no-session':
      return { body: plain.body, answer: { status: 202, body: '' }, copies: 1 }
    case 'twice':
      return { ...plain, copies: 2 }
    case 'early':
      return plain
    case 'non-empty-result':
      return { ...plain, body: { result: { ok: true }, jsonrpc: '2.0', id } }
    case 'error':
      return {
        ...plain,
        body: { jsonrpc: '2.0', id, error: { code: -32_601, message: 'Method not found' } }
      }
    case 'extra-member':
      return { ...plain, body: { result: {}, jsonrpc: '2.0', id, extra: 1 } }
    case 'other-id':
      return { ...plain, body: { result: {}, jsonrpc: '2.0', id: 'server-ping-other' } }
  }
}

/** The client's answers to `ping`, as the generated flaw makes them (none when missing). */
const answersTo = (ping: Ping): ReadonlyArray<McpObservedExchange> => {
  const id = rpcId(ping.id)

  const plain: ClientAnswer = {
    body: { result: {}, jsonrpc: '2.0', id },
    answer: { status: 202, body: '' },
    session: session1,
    copies: 1
  }

  const sent = ping.answerPerturbed ? perturbed(ping.answer, plain, id) : plain

  const exchange = withSession(
    post(sent.body, sent.answer),
    sent.session === undefined ? {} : { request: sent.session }
  )

  return Array.from({ length: sent.copies }, () => exchange)
}

const noiseMessages = (noise: Noise, ownResponse: JsonObject): ReadonlyArray<Json> => {
  switch (noise.kind) {
    case 'notification':
      return [
        { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'x' } }
      ]
    case 'stray-response':
      return [{ jsonrpc: '2.0', id: 'stray-1', result: {} }]
    case 'duplicate-own-response':
      return [ownResponse]
    case 'stray-answer':
      return []
  }
}

/** The call operation the script describes, in the order the observer records it. */
const operation = (script: Script): ReadonlyArray<McpObservedExchange> => {
  const pingsAt = (where: typeof Where.Type) => script.pings.filter(ping => ping.where === where)

  const isEarly = (ping: Ping) => ping.answerPerturbed && ping.answer === 'early'

  const answered = (where: typeof Where.Type, early: boolean) =>
    pingsAt(where)
      .filter(ping => isEarly(ping) === early)
      .flatMap(answersTo)

  const carrier = (
    where: typeof Where.Type,
    requestBody: JsonObject,
    response: JsonObject
  ): McpObservedExchange => {
    const messages = [
      ...pingsAt(where).map(pingMessage),
      ...script.noise
        .filter(noise => noise.where === where)
        .flatMap(noise => noiseMessages(noise, response)),
      response
    ]

    const exchange = post(requestBody, { status: 200, body: sse(messages), sse: true })

    return where === 'initialize'
      ? withSession(exchange, { response: session1 })
      : withSession(exchange, { request: session1, response: session1 })
  }

  const later = { request: session1, response: session1 }

  const strayAnswers = script.noise
    .filter(noise => noise.kind === 'stray-answer')
    .map(() =>
      withSession(post({ result: {}, jsonrpc: '2.0', id: 'stray-1' }, { status: 202, body: '' }), {
        request: session1
      })
    )

  return [
    post(
      { jsonrpc: '2.0', id: mcpConformanceDiscoverRequestId, method: 'server/discover' },
      { status: 400, body: '{"jsonrpc":"2.0","error":{"code":-32000,"message":"x"},"id":null}' }
    ),
    ...answered('initialize', true),
    carrier(
      'initialize',
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 0, result: mcpConformanceLegacyInitializeResult }
    ),
    ...answered('initialize', false),
    withSession(
      post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { status: 202, body: '' }),
      later
    ),
    withSession({ method: 'GET', url, requestHeaders: {}, status: 405, responseBody: '' }, later),
    ...answered('listing', true),
    carrier(
      'listing',
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 1, result: { tools: [...mcpConformanceSyntheticTools] } }
    ),
    ...answered('listing', false),
    ...strayAnswers
  ]
}

const call = post({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { ...mcpConformanceSyntheticReadCall }
})

const forwards = (exchanges: ReadonlyArray<McpObservedExchange>) =>
  gateVerdict(gate, call, exchanges, () => undefined) === undefined

// The property's oracle: the claim, read off the exchanges (not off the generated script).

const isObjectMessage = (value: Json | undefined): value is JsonObject => Predicate.isObject(value)

const idOf = (value: Json | undefined): Json | undefined =>
  isObjectMessage(value) ? value['id'] : undefined

const isClientResponse = (exchange: McpObservedExchange): boolean =>
  exchange.method === 'POST' &&
  isObjectMessage(exchange.requestBody) &&
  'id' in exchange.requestBody &&
  !('method' in exchange.requestBody)

const isParamlessPing = (message: JsonObject): boolean => {
  const params = message['params']

  return (
    Object.keys(message).every(key => ['jsonrpc', 'id', 'method', 'params'].includes(key)) &&
    message['jsonrpc'] === '2.0' &&
    (Predicate.isString(message['id']) || Predicate.isNumber(message['id'])) &&
    message['method'] === 'ping' &&
    (!('params' in message) || (isObjectMessage(params) && Object.keys(params).length === 0))
  )
}

const messagesRead = (exchange: McpObservedExchange): ReadonlyArray<Json> =>
  exchange.mediaType === 'text/event-stream' && exchange.responseBody !== undefined
    ? sseMessagePayloads([exchange.responseBody]).flatMap(payload =>
        Option.toArray(parseWireJson(payload))
      )
    : []

/** The claim's violations in `exchanges` (none when it holds). */
const violations = (exchanges: ReadonlyArray<McpObservedExchange>): ReadonlyArray<string> => {
  const pings: Array<{ readonly id: Json | undefined; readonly index: number }> = []

  const unaccounted = exchanges.flatMap((carrier, index) => {
    const ownId = idOf(carrier.requestBody)
    const session = carrier.responseSession?.id ?? carrier.requestSession?.id

    return messagesRead(carrier).flatMap(message => {
      if (!isObjectMessage(message)) {
        return [`#${index}: a message that is not an object`]
      }

      if (
        ownId !== undefined &&
        message['id'] === ownId &&
        ('result' in message || 'error' in message)
      ) {
        return []
      }

      if (Predicate.isString(message['method']) && !('id' in message)) {
        return []
      }

      if (!isParamlessPing(message)) {
        return [`#${index}: a server message that is no response, notification or plain ping`]
      }

      pings.push({ id: message['id'], index })

      const answers = exchanges
        .slice(index + 1)
        .filter(
          exchange => isClientResponse(exchange) && idOf(exchange.requestBody) === message['id']
        )

      const [answer] = answers

      return answers.length === 1 &&
        answer !== undefined &&
        isDeepStrictEqual(answer.requestBody, { jsonrpc: '2.0', id: message['id'], result: {} }) &&
        answer.status === 202 &&
        answer.responseBody === '' &&
        answer.requestSession?.id === session
        ? []
        : [`#${index}: ping ${JSON.stringify(message['id'])} without one later accepted answer`]
    })
  })

  const strays = exchanges.flatMap((exchange, index) =>
    isClientResponse(exchange) &&
    !pings.some(ping => ping.index < index && ping.id === idOf(exchange.requestBody))
      ? [`#${index}: a client response that answers no earlier plain ping`]
      : []
  )

  return [...unaccounted, ...strays]
}

const plainPing: Ping = {
  id: 'a',
  where: 'initialize',
  emptyParams: false,
  malformed: false,
  malformation: 'params',
  answerPerturbed: false,
  answer: 'rejected'
}

describe('call gate: an answered server ping (#382), property', () => {
  it.prop(
    'whenever the gate forwards, every server message and client response is accounted for',
    [Script],
    ([script]) => {
      const exchanges = operation(script)

      if (forwards(exchanges)) {
        expect(violations(exchanges), JSON.stringify(script)).toEqual([])
      }
    },
    propertyOptions
  )

  // The property must not hold vacuously: generation reaches both verdicts, and forwarded
  // operations that carry pings.
  it.effect('generated operations reach both verdicts, with pings among the forwarded ones', () =>
    Effect.gen(function* () {
      const scripts = yield* Arbitrary.sampleEffect(Arbitrary.schema(Script), {
        count: 500,
        seed: 382
      })

      const forwarded = scripts.filter(script => forwards(operation(script)))

      expect(forwarded.length).toBeGreaterThan(0)
      expect(forwarded.length).toBeLessThan(scripts.length)
      expect(forwarded.some(script => script.pings.length > 0)).toBe(true)
    })
  )

  it('the oracle accepts an accepted answer and flags a rejected one', () => {
    const accepted: Script = { pings: [plainPing], noise: [] }
    const rejected: Script = { pings: [{ ...plainPing, answerPerturbed: true }], noise: [] }

    expect(forwards(operation(accepted))).toBe(true)
    expect(violations(operation(accepted))).toEqual([])
    expect(forwards(operation(rejected))).toBe(false)
    expect(violations(operation(rejected))).toHaveLength(1)
  })
})
