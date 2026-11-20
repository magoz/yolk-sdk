/**
 * The fail-closed call gate: every calling case forwards a `tools/call` only on positive evidence
 * from the call operation's own listing, and refuses (with zero forwarded calls) on anything else.
 * Also the parsing edge cases the SDK reads with `JSON.parse` and `eventsource-parser`.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Cause, Deferred, Effect, Exit, Layer, Predicate, Ref } from 'effect'
import * as Schema from 'effect/Schema'
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse
} from 'effect/http'
import { describe, expect, it } from '@effect/vitest'
import type { WireExchange, WireFixture, WireResponse } from '@yolk-sdk/conformance/fixture'
import { makeReplayHttpClient, type ReplayLedgerApi } from '@yolk-sdk/conformance/replay'
import { EventSourceParserStream } from 'eventsource-parser/stream'
import {
  legacyServerPingListingExchanges,
  mcpCallReadCase,
  mcpCallReadLegacyFixture,
  mcpCallReadModernFixture,
  mcpCallToolErrorCase,
  mcpCallToolErrorLegacyFixture,
  mcpCallToolErrorModernFixture,
  mcpConformanceDiscoverRequestId,
  mcpConformanceLegacyInitializeResult,
  mcpConformanceModernDiscoverResult,
  mcpConformanceSyntheticLegacyUrl,
  mcpConformanceSyntheticModernUrl,
  mcpConformanceSyntheticReadCall,
  mcpConformanceSyntheticReadTool,
  mcpConformanceSyntheticTarget,
  mcpConformanceSyntheticTools,
  mcpConformanceSyntheticWriteTool,
  mcpNegotiationEraCase,
  mcpNegotiationEraModernFixture,
  mcpResponseEncodingCase,
  mcpResponseEncodingLegacyFixture,
  mcpResponseEncodingModernFixture,
  mcpUnknownToolCase,
  mcpUnknownToolLegacyFixture,
  mcpUnknownToolModernFixture,
  modernCallExchanges,
  modernListingExchanges,
  type McpConformanceCase
} from '../../src/conformance/index.ts'
import { gateVerdict, type McpCallGate } from '../../src/conformance/call-gate.ts'
import type { McpObservedExchange, McpObservedSession } from '../../src/conformance/observe.ts'
import {
  decodeAsTextDecoderStream,
  sseAllPayloads,
  sseMessagePayloads
} from '../../src/conformance/sse.ts'
import {
  caseServices,
  drillFixture,
  eraOf,
  lastIndexOf,
  ledgerMethods,
  replayLayer,
  withResponse,
  withStreams
} from './helpers.ts'

const absentTool = { name: 'yolk_conformance_absent', inputSchema: { type: 'object' } }

const refusedMessage = (reason: string) =>
  `precondition: the call operation's own wire evidence does not prove the call safe (${reason}); the observer did not forward tools/call`

const jsonAnswer = (body: string): WireResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body
})

const page = (tools: ReadonlyArray<object>, nextCursor?: string) => {
  const result = { tools, resultType: 'complete', ttlMs: 0, cacheScope: 'private' }

  return nextCursor === undefined ? result : { ...result, nextCursor }
}

const listAnswer = (id: number, tools: ReadonlyArray<object>, nextCursor?: string) =>
  jsonAnswer(JSON.stringify({ jsonrpc: '2.0', id, result: page(tools, nextCursor) }))

/** Run the case against replayed `fixture`; return its failure and the forwarded RPC methods. */
const refusedAgainst = (testCase: McpConformanceCase, fixture: WireFixture) =>
  Effect.gen(function* () {
    const ledger = yield* Ref.make<ReplayLedgerApi | undefined>(undefined)

    const error = yield* testCase.run.pipe(
      Effect.provide(replayLayer([fixture], eraOf(fixture), { ledger })),
      Effect.flip
    )

    return { error, methods: yield* ledgerMethods(ledger) }
  })

const passAgainst = (testCase: McpConformanceCase, fixture: WireFixture) =>
  testCase.run.pipe(Effect.provide(replayLayer([fixture], eraOf(fixture))))

const parseBody = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

const sse = (message: object) => `event: message\ndata: ${JSON.stringify(message)}\n\n`

const sseResponse = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], text: string) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(text, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'mcp-session-id': 'yolk-synthetic-session-0001'
      }
    })
  )

/**
 * A scripted legacy server for the standing-GET drill. The precondition operation lists cleanly.
 * On the call operation, tools/list is answered 202 and its response (listing the absent tool) is
 * delivered on the standing GET once tools/list was sent. Counts every tools/call that arrives.
 */
const standingGetServer = Effect.gen(function* () {
  const listSent = yield* Deferred.make<void>()
  const initializes = yield* Ref.make(0)
  const calls = yield* Ref.make(0)

  const client = HttpClient.make(request =>
    Effect.gen(function* () {
      const operation = yield* Ref.get(initializes)

      if (request.method === 'GET') {
        if (operation < 2) {
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 405 }))
        }

        yield* Deferred.await(listSent)

        return sseResponse(
          request,
          sse({
            jsonrpc: '2.0',
            id: 1,
            result: { tools: [...mcpConformanceSyntheticTools, absentTool] }
          })
        )
      }

      const text = Predicate.isTagged(request.body, 'Uint8Array')
        ? new TextDecoder().decode(request.body.body)
        : '{}'

      const body = yield* parseBody(text).pipe(Effect.orDie)
      const method = Predicate.hasProperty(body, 'method') ? body.method : undefined
      const id = Predicate.hasProperty(body, 'id') ? body.id : undefined

      switch (method) {
        case 'server/discover':
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Server not initialized"},"id":null}',
              { status: 400, headers: { 'content-type': 'application/json' } }
            )
          )
        case 'initialize':
          yield* Ref.update(initializes, count => count + 1)

          return sseResponse(
            request,
            sse({ jsonrpc: '2.0', id, result: mcpConformanceLegacyInitializeResult })
          )
        case 'tools/list':
          if (operation < 2) {
            return sseResponse(
              request,
              sse({ jsonrpc: '2.0', id, result: { tools: [...mcpConformanceSyntheticTools] } })
            )
          }

          yield* Deferred.succeed(listSent, undefined)

          return HttpClientResponse.fromWeb(request, new Response(null, { status: 202 }))
        case 'tools/call':
          yield* Ref.update(calls, count => count + 1)

          return sseResponse(
            request,
            sse({ jsonrpc: '2.0', id, error: { code: -32_602, message: 'Unknown tool' } })
          )
        default:
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 202 }))
      }
    })
  )

  return { client, calls }
})

describe('the fail-closed call gate refuses, with zero forwarded tools/call', () => {
  it.effect('a listing delivered on the standing GET after a 202 (legacy)', () =>
    Effect.gen(function* () {
      const server = yield* standingGetServer

      const error = yield* mcpUnknownToolCase.run.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, server.client),
            caseServices(mcpConformanceSyntheticTarget('legacy'))
          )
        ),
        Effect.flip
      )

      expect(error.message).toBe(refusedMessage('uncertain-exchange'))
      expect(yield* Ref.get(server.calls)).toBe(0)
    })
  )

  it.effect('a priming event, a closed stream, then the listing replayed on a GET', () =>
    Effect.gen(function* () {
      const primed = withResponse(
        mcpUnknownToolModernFixture,
        lastIndexOf(mcpUnknownToolModernFixture, 'tools/list'),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          chunks: ['id: evt-1\nretry: 10\ndata: \n\n']
        }
      )

      const replayed: WireExchange = {
        request: { method: 'GET', url: mcpConformanceSyntheticModernUrl },
        response: {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          chunks: [
            `id: evt-2\ndata: ${JSON.stringify({
              jsonrpc: '2.0',
              id: 0,
              result: page([...mcpConformanceSyntheticTools, absentTool])
            })}\n\n`
          ]
        }
      }

      const { error, methods } = yield* refusedAgainst(
        mcpUnknownToolCase,
        drillFixture('mcp.errors.unknown-tool', 'modern', [...primed.exchanges, replayed])
      )

      expect(error.message).toBe(refusedMessage('uncertain-exchange'))
      expect(methods).not.toContain('tools/call')
      expect(methods).toContain('GET')
    })
  )

  it.effect('a call-operation listing holding 1e400 that names the absent tool', () =>
    Effect.gen(function* () {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        result: { ...page([...mcpConformanceSyntheticTools, absentTool]), x: 0 }
      }).replace('"x":0', '"x":1e400')

      const { error, methods } = yield* refusedAgainst(
        mcpUnknownToolCase,
        withResponse(
          mcpUnknownToolModernFixture,
          lastIndexOf(mcpUnknownToolModernFixture, 'tools/list'),
          jsonAnswer(body)
        )
      )

      expect(error.message).toBe(refusedMessage('tool-listed'))
      expect(methods).not.toContain('tools/call')
    })
  )

  // Since client 2.2.0 the SDK follows a repeated cursor and stops only on a repeated page: the
  // same items under the same `nextCursor` (#2886). The listing still ends with a cursor.
  it.effect('an incomplete multi-page listing (a repeated page stops the SDK early)', () =>
    Effect.gen(function* () {
      const [discover, firstList, callExchange] = modernCallExchanges(
        { name: 'yolk_conformance_absent', arguments: {} },
        { kind: 'error', status: 400, code: -32_602, message: 'Unknown tool' }
      )

      if (discover === undefined || firstList === undefined || callExchange === undefined) {
        return expect.fail('fixture too short')
      }

      const fixture = drillFixture('mcp.errors.unknown-tool', 'modern', [
        ...modernListingExchanges(),
        discover,
        { ...firstList, response: listAnswer(0, [mcpConformanceSyntheticReadTool], 'cursor-1') },
        { ...firstList, response: listAnswer(1, [mcpConformanceSyntheticReadTool], 'cursor-1') },
        callExchange
      ])

      const { error, methods } = yield* refusedAgainst(mcpUnknownToolCase, fixture)

      expect(error.message).toBe(refusedMessage('incomplete-listing'))
      expect(methods).not.toContain('tools/call')
    })
  )

  const readOnlyVariants: ReadonlyArray<{
    readonly label: string
    readonly annotations: { readonly readOnlyHint: boolean } | undefined
  }> = [
    { label: 'downgraded to readOnlyHint: false', annotations: { readOnlyHint: false } },
    { label: 'removed', annotations: undefined }
  ]

  const readCases: ReadonlyArray<{
    readonly testCase: McpConformanceCase
    readonly fixture: WireFixture
  }> = [
    { testCase: mcpCallReadCase, fixture: mcpCallReadModernFixture },
    { testCase: mcpCallToolErrorCase, fixture: mcpCallToolErrorModernFixture }
  ]

  for (const { label, annotations } of readOnlyVariants) {
    it.effect(`a read tool whose call-operation listing has readOnlyHint ${label}`, () =>
      Effect.gen(function* () {
        const { annotations: _annotations, ...withoutAnnotations } = mcpConformanceSyntheticReadTool

        const readTool =
          annotations === undefined
            ? withoutAnnotations
            : { ...mcpConformanceSyntheticReadTool, annotations }

        for (const { testCase, fixture } of readCases) {
          const { error, methods } = yield* refusedAgainst(
            testCase,
            withResponse(
              fixture,
              lastIndexOf(fixture, 'tools/list'),
              listAnswer(0, [readTool, mcpConformanceSyntheticWriteTool])
            )
          )

          expect(error.message, testCase.id).toBe(refusedMessage('tool-not-read-only'))
          expect(methods, testCase.id).not.toContain('tools/call')
        }
      })
    )
  }
})

/** The three literal characters `eventsource-parser` strips from the first chunk (`ï»¿`). */
const firstChunkMarker = '\u00EF\u00BB\u00BF'

const sseAnswer = (chunks: ReadonlyArray<string>): WireResponse => ({
  status: 200,
  headers: { 'content-type': 'text/event-stream' },
  chunks: [...chunks]
})

const dataEvent = (message: object) => `data: ${JSON.stringify(message)}\n\n`

describe('the gate reads SSE with the SDK parser (first-chunk marker)', () => {
  it.effect('absent: a marker-prefixed unsafe listing, then a safe one with the same id', () =>
    Effect.gen(function* () {
      const { error, methods } = yield* refusedAgainst(
        mcpUnknownToolCase,
        withResponse(
          mcpUnknownToolModernFixture,
          lastIndexOf(mcpUnknownToolModernFixture, 'tools/list'),
          sseAnswer([
            `${firstChunkMarker}${dataEvent({
              jsonrpc: '2.0',
              id: 0,
              result: page([...mcpConformanceSyntheticTools, absentTool])
            })}`,
            dataEvent({ jsonrpc: '2.0', id: 0, result: page([...mcpConformanceSyntheticTools]) })
          ])
        )
      )

      expect(error.message).toBe(refusedMessage('uncertain-exchange'))
      expect(methods).not.toContain('tools/call')
    })
  )

  it.effect('read-only: a marker-prefixed non-read-only listing, then a read-only one', () =>
    Effect.gen(function* () {
      const unsafe = { ...mcpConformanceSyntheticReadTool, annotations: { readOnlyHint: false } }

      for (const { testCase, fixture } of [
        { testCase: mcpCallReadCase, fixture: mcpCallReadModernFixture },
        { testCase: mcpCallToolErrorCase, fixture: mcpCallToolErrorModernFixture }
      ]) {
        const { error, methods } = yield* refusedAgainst(
          testCase,
          withResponse(
            fixture,
            lastIndexOf(fixture, 'tools/list'),
            sseAnswer([
              `${firstChunkMarker}${dataEvent({
                jsonrpc: '2.0',
                id: 0,
                result: page([unsafe, mcpConformanceSyntheticWriteTool])
              })}`,
              dataEvent({
                jsonrpc: '2.0',
                id: 0,
                result: page([mcpConformanceSyntheticReadTool, mcpConformanceSyntheticWriteTool])
              })
            ])
          )
        )

        expect(error.message, testCase.id).toBe(refusedMessage('uncertain-exchange'))
        expect(methods, testCase.id).not.toContain('tools/call')
      }
    })
  )

  it.effect('response-encoding reads a marker-prefixed single event as the client does', () =>
    passAgainst(
      mcpResponseEncodingCase,
      withStreams(mcpResponseEncodingLegacyFixture, chunks =>
        chunks.length === 0 ? chunks : [`${firstChunkMarker}${chunks.join('')}`]
      )
    )
  )
})

describe('the gate understands the era probe only when its answer is fully accounted for', () => {
  it.effect('a probe stream whose tail carries a tools/list-shaped response for id 0', () =>
    Effect.gen(function* () {
      const probeIndex = 2

      const { error, methods } = yield* refusedAgainst(
        mcpUnknownToolCase,
        withResponse(
          mcpUnknownToolModernFixture,
          probeIndex,
          sseAnswer([
            dataEvent({
              jsonrpc: '2.0',
              id: mcpConformanceDiscoverRequestId,
              result: mcpConformanceModernDiscoverResult
            }),
            dataEvent({
              jsonrpc: '2.0',
              id: 0,
              result: page([...mcpConformanceSyntheticTools, absentTool])
            })
          ])
        )
      )

      expect(methods.slice(0, 3)).toEqual(['server/discover', 'tools/list', 'server/discover'])
      expect(error.message).toBe(refusedMessage('uncertain-exchange'))
      expect(methods).not.toContain('tools/call')
    })
  )
})

describe('a refused client retry is reported as a retry, not as zero forwarded calls', () => {
  it.effect('HeaderMismatch on the first call, a re-list, then a refused second call', () =>
    Effect.gen(function* () {
      const [discover, list, call] = modernCallExchanges(
        { name: 'yolk_conformance_absent', arguments: {} },
        { kind: 'error', status: 400, code: -32_020, message: 'Header mismatch' }
      )

      if (discover === undefined || list === undefined || call === undefined) {
        return expect.fail('fixture too short')
      }

      const fixture = drillFixture('mcp.errors.unknown-tool', 'modern', [
        ...modernListingExchanges(),
        discover,
        list,
        call,
        { ...list, response: listAnswer(2, [...mcpConformanceSyntheticTools]) },
        call
      ])

      const { error, methods } = yield* refusedAgainst(mcpUnknownToolCase, fixture)

      expect(error.message).toBe(
        'expected one tools/call per operation: the client retried tools/call after a forwarded call, and the observer refused the retry (unexpected-call)'
      )
      expect(methods.filter(method => method === 'tools/call')).toHaveLength(1)
    })
  )
})

/** A legacy calling case and its committed fixture. */
const legacyCalling: ReadonlyArray<{
  readonly testCase: McpConformanceCase
  readonly fixture: WireFixture
}> = [
  { testCase: mcpCallReadCase, fixture: mcpCallReadLegacyFixture },
  { testCase: mcpCallToolErrorCase, fixture: mcpCallToolErrorLegacyFixture },
  { testCase: mcpUnknownToolCase, fixture: mcpUnknownToolLegacyFixture }
]

/** Whether a request body is a client-sent response (a JSON-RPC message without `method`). */
const isClientResponse = (body: unknown) =>
  Predicate.hasProperty(body, 'jsonrpc') && !Predicate.hasProperty(body, 'method')

/**
 * The listing of a server that pings during `initialize`, without the client's answer: the test
 * client answers it (replay matches per method and URL in order, and the client sends the answer
 * concurrently with `notifications/initialized`, so a recorded answer could go to either).
 */
const pingListing = legacyServerPingListingExchanges().filter(
  exchange => !isClientResponse(exchange.request.body)
)

/**
 * `fixture` (a legacy calling fixture) against a server that pings during every `initialize`. Each
 * operation ends its session with a `DELETE` (`pingListing` ends with it, and `rest` carries the
 * second); replay matches it on its own method, after the operation's POSTs.
 */
const pinging = (fixture: WireFixture, callInitialize?: WireResponse): WireFixture => {
  const call = fixture.exchanges
    .filter(exchange => {
      const body = exchange.request.body

      return Predicate.hasProperty(body, 'method') && body.method === 'tools/call'
    })
    .at(-1)

  const [discover, initialize, ...rest] = pingListing

  if (call === undefined || discover === undefined || initialize === undefined) {
    throw new Error('empty fixture')
  }

  return drillFixture(fixture.caseId, 'legacy', [
    ...pingListing,
    discover,
    callInitialize === undefined ? initialize : { ...initialize, response: callInitialize },
    ...rest,
    call
  ])
}

/** An `initialize` answer that sends `serverRequest` before its response. */
const initializeSending = (serverRequest: object): WireResponse => ({
  status: 200,
  headers: {
    'content-type': 'text/event-stream',
    'mcp-session-id': 'yolk-synthetic-session-0001'
  },
  chunks: [
    `event: message\nid: evt-1\ndata: ${JSON.stringify(serverRequest)}\n\n`,
    `event: message\nid: evt-2\ndata: ${JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      result: mcpConformanceLegacyInitializeResult
    })}\n\n`
  ]
})

type ServerAnswer = (
  request: HttpClientRequest.HttpClientRequest
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>

const answerWith =
  (
    status: number,
    body: string | null = null,
    headers: Record<string, string> = {}
  ): ServerAnswer =>
  request =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status, headers })))

const accepted = answerWith(202)

/**
 * Run `testCase` against `fixture` replayed: the client's answer in the precondition listing is
 * accepted (202, no body), and its answer in the call operation is answered by `callAnswer`;
 * count the client's answers and calls.
 */
const runPinged = (
  testCase: McpConformanceCase,
  fixture: WireFixture,
  callAnswer: ServerAnswer = accepted
) =>
  Effect.gen(function* () {
    const answers = yield* Ref.make(0)
    const calls = yield* Ref.make(0)
    const replay = yield* makeReplayHttpClient([fixture])

    const client = HttpClient.make(request =>
      Effect.gen(function* () {
        const text = Predicate.isTagged(request.body, 'Uint8Array')
          ? new TextDecoder().decode(request.body.body)
          : '{}'

        const body = yield* parseBody(text).pipe(Effect.orDie)

        if (isClientResponse(body)) {
          const answered = yield* Ref.updateAndGet(answers, count => count + 1)

          // The first answer is the precondition listing's; the second the call operation's.
          return yield* (answered === 1 ? accepted : callAnswer)(request)
        }

        if (Predicate.hasProperty(body, 'method') && body.method === 'tools/call') {
          yield* Ref.update(calls, count => count + 1)
        }

        return yield* replay.client.execute(request)
      })
    )

    const exit = yield* testCase.run.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, client),
          caseServices(mcpConformanceSyntheticTarget('legacy'))
        )
      ),
      Effect.exit
    )

    return { exit, answers: yield* Ref.get(answers), calls: yield* Ref.get(calls) }
  })

describe('a server ping during initialize (#382)', () => {
  it.effect('the calling cases forward their call once the answer was accepted', () =>
    Effect.gen(function* () {
      for (const { testCase, fixture } of legacyCalling) {
        const { exit, answers, calls } = yield* runPinged(testCase, pinging(fixture))

        expect(Exit.isSuccess(exit), `${testCase.id}: ${String(exit)}`).toBe(true)
        // Both handshakes pinged, and the client answered each.
        expect(answers, testCase.id).toBe(2)
        expect(calls, testCase.id).toBe(1)
      }
    })
  )

  const transportFailure: ServerAnswer = request =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, description: 'synthetic drop' })
      })
    )

  const refusals: ReadonlyArray<{
    readonly label: string
    readonly callInitialize?: WireResponse
    readonly callAnswer?: ServerAnswer
  }> = [
    { label: 'the server rejects the answer to its ping (400)', callAnswer: answerWith(400) },
    {
      label: 'the server answers the ping answer 202 with a body',
      callAnswer: answerWith(202, '{}', { 'content-type': 'application/json' })
    },
    { label: 'the answer never reaches the server (no status)', callAnswer: transportFailure },
    {
      label: 'the ping carries params',
      callInitialize: initializeSending({
        jsonrpc: '2.0',
        id: 'server-ping-1',
        method: 'ping',
        params: { reason: 'synthetic' }
      })
    },
    {
      label: 'the server sends roots/list instead (answered with an error)',
      callInitialize: initializeSending({
        jsonrpc: '2.0',
        id: 'server-roots-1',
        method: 'roots/list'
      })
    }
  ]

  for (const { label, callInitialize, callAnswer } of refusals) {
    it.effect(`refuses with zero forwarded calls when ${label}`, () =>
      Effect.gen(function* () {
        for (const { testCase, fixture } of legacyCalling) {
          const { exit, answers, calls } = yield* runPinged(
            testCase,
            pinging(fixture, callInitialize),
            callAnswer
          )

          expect(Exit.isFailure(exit), testCase.id).toBe(true)

          if (Exit.isFailure(exit)) {
            expect(Cause.squash(exit.cause), testCase.id).toMatchObject({
              message: refusedMessage('uncertain-exchange')
            })
          }

          // The client still answered the server request of the call operation.
          expect(answers, testCase.id).toBe(2)
          expect(calls, testCase.id).toBe(0)
        }
      })
    )
  }
})

const legacyUrl = mcpConformanceSyntheticLegacyUrl

const readGate: McpCallGate = { kind: 'read-only', name: mcpConformanceSyntheticReadCall.name }

const ssePayloads = (messages: ReadonlyArray<object>) =>
  messages.map(message => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join('')

/** An observed POST: its JSON-RPC body and, when answered, the status and the whole body. */
const observedPost = (
  requestBody: Schema.Json,
  answer?: { readonly status: number; readonly body: string; readonly mediaType?: string }
): McpObservedExchange => {
  const sent: McpObservedExchange = {
    method: 'POST',
    url: legacyUrl,
    requestHeaders: {},
    requestBody
  }

  if (answer === undefined) {
    return sent
  }

  const answered = { ...sent, status: answer.status, responseBody: answer.body }

  return answer.mediaType === undefined ? answered : { ...answered, mediaType: answer.mediaType }
}

const sseAnswered = (messages: ReadonlyArray<object>) => ({
  status: 200,
  body: ssePayloads(messages),
  mediaType: 'text/event-stream'
})

const serverPing = (id: string | number = 'server-ping-1'): Schema.JsonObject => ({
  jsonrpc: '2.0',
  id,
  method: 'ping'
})

const probe = observedPost(
  { jsonrpc: '2.0', id: mcpConformanceDiscoverRequestId, method: 'server/discover' },
  {
    status: 400,
    body: '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request"},"id":null}',
    mediaType: 'application/json'
  }
)

/** `initialize` (id 0) answered over SSE: `before` (server requests), then its response. */
const initialize = (before: ReadonlyArray<object>) =>
  observedPost(
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} },
    sseAnswered([
      ...before,
      { jsonrpc: '2.0', id: 0, result: mcpConformanceLegacyInitializeResult }
    ])
  )

/** The client's empty-result answer to server request `id`, accepted (202, no body) by default. */
const pingAnswer = (
  id: string | number,
  answer: { readonly status: number; readonly body: string } = { status: 202, body: '' }
) => observedPost({ result: {}, jsonrpc: '2.0', id }, answer)

/** The same answer while the server has not answered it yet (no status, no body). */
const pingAnswerInFlight = (id: string | number) => observedPost({ result: {}, jsonrpc: '2.0', id })

const initialized = observedPost(
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { status: 202, body: '' }
)

/** The standing GET answered 405, or 200 with an event stream carrying `body`. */
const standingGet = (body = ''): McpObservedExchange => {
  const sent = { method: 'GET', url: legacyUrl, requestHeaders: {} }

  return body === ''
    ? { ...sent, status: 405, responseBody: '' }
    : { ...sent, status: 200, responseBody: body, mediaType: 'text/event-stream' }
}

const listing = (before: ReadonlyArray<object> = []) =>
  observedPost(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    sseAnswered([
      ...before,
      { jsonrpc: '2.0', id: 1, result: { tools: [...mcpConformanceSyntheticTools] } }
    ])
  )

const call = observedPost({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { ...mcpConformanceSyntheticReadCall }
})

/** The call operation of a server that pings once during `initialize`, answered and accepted. */
const pingedOperation: ReadonlyArray<McpObservedExchange> = [
  probe,
  initialize([serverPing()]),
  pingAnswer('server-ping-1'),
  initialized,
  standingGet(),
  listing()
]

const session1 = { id: 'session#1', visibleAscii: true }

const session2 = { id: 'session#2', visibleAscii: true }

/**
 * `pingedOperation` as the observer records a session: `initialize` answered with `session#1`, the
 * later requests sending it, and the ping's answer sending `answerSession` (none when absent).
 */
const sessionedOperation = (answerSession?: McpObservedSession) =>
  pingedOperation.map((exchange, index) => {
    if (index === 1) {
      return { ...exchange, responseSession: session1 }
    }

    if (index === 2) {
      return answerSession === undefined ? exchange : { ...exchange, requestSession: answerSession }
    }

    return index > 2
      ? { ...exchange, requestSession: session1, responseSession: session1 }
      : exchange
  })

const verdictOf = (earlier: ReadonlyArray<McpObservedExchange>) =>
  gateVerdict(readGate, call, earlier, () => undefined)

describe('the gate understands only an accepted answer to a plain server ping (#382)', () => {
  const forwarded: ReadonlyArray<{
    readonly label: string
    readonly earlier: ReadonlyArray<McpObservedExchange>
  }> = [
    {
      label: 'no ping at all',
      earlier: [probe, initialize([]), initialized, standingGet(), listing()]
    },
    { label: 'a ping answered and accepted', earlier: pingedOperation },
    {
      label: 'a ping with empty params and a numeric id',
      earlier: [
        probe,
        initialize([{ ...serverPing(7), params: {} }]),
        pingAnswer(7),
        initialized,
        standingGet(),
        listing()
      ]
    },
    {
      label: 'two pings, each answered once',
      earlier: [
        probe,
        initialize([serverPing('a'), serverPing('b')]),
        pingAnswer('b'),
        pingAnswer('a'),
        initialized,
        standingGet(),
        listing()
      ]
    },
    {
      label: 'a ping answered in the session initialize issued',
      earlier: sessionedOperation(session1)
    },
    {
      label: 'a ping in the listing answer, answered before the call',
      earlier: [
        probe,
        initialize([]),
        initialized,
        standingGet(),
        listing([serverPing()]),
        pingAnswer('server-ping-1')
      ]
    }
  ]

  for (const { label, earlier } of forwarded) {
    it(`forwards: ${label}`, () => {
      expect(verdictOf(earlier)).toBeUndefined()
    })
  }

  /** `pingedOperation` with the exchange at `index` replaced (or removed with no exchanges). */
  const replaced = (index: number, ...exchanges: ReadonlyArray<McpObservedExchange>) => [
    ...pingedOperation.slice(0, index),
    ...exchanges,
    ...pingedOperation.slice(index + 1)
  ]

  const otherRequests: ReadonlyArray<Schema.JsonObject> = [
    { jsonrpc: '2.0', id: 'server-roots-1', method: 'roots/list' },
    { jsonrpc: '2.0', id: 'server-sampling-1', method: 'sampling/createMessage', params: {} },
    { jsonrpc: '2.0', id: 'server-elicit-1', method: 'elicitation/create', params: {} },
    { jsonrpc: '2.0', id: 'server-ping-1', method: 'Ping' }
  ]

  const refused: ReadonlyArray<{
    readonly label: string
    readonly earlier: ReadonlyArray<McpObservedExchange>
  }> = [
    { label: 'a ping the client never answered', earlier: replaced(2) },
    {
      label: 'an answer still in flight (no status)',
      earlier: replaced(2, pingAnswerInFlight('server-ping-1'))
    },
    {
      label: 'an answer the server rejected (400)',
      earlier: replaced(2, pingAnswer('server-ping-1', { status: 400, body: '' }))
    },
    {
      label: 'an answer accepted 200 instead of 202',
      earlier: replaced(2, pingAnswer('server-ping-1', { status: 200, body: '' }))
    },
    {
      label: 'an answer accepted 202 with a body',
      earlier: replaced(2, pingAnswer('server-ping-1', { status: 202, body: '{}' }))
    },
    {
      label: 'an answer with a non-empty result',
      earlier: replaced(
        2,
        observedPost(
          { result: { ok: true }, jsonrpc: '2.0', id: 'server-ping-1' },
          {
            status: 202,
            body: ''
          }
        )
      )
    },
    {
      label: 'an error answer',
      earlier: replaced(
        2,
        observedPost(
          { jsonrpc: '2.0', id: 'server-ping-1', error: { code: -32_601, message: 'x' } },
          { status: 202, body: '' }
        )
      )
    },
    {
      label: 'an answer with an extra member',
      earlier: replaced(
        2,
        observedPost(
          { result: {}, jsonrpc: '2.0', id: 'server-ping-1', extra: 1 },
          {
            status: 202,
            body: ''
          }
        )
      )
    },
    { label: 'an answer to another id', earlier: replaced(2, pingAnswer('server-ping-2')) },
    { label: 'an answer in another session', earlier: sessionedOperation(session2) },
    { label: 'an answer without the issued session', earlier: sessionedOperation() },
    {
      label: 'the ping answered twice',
      earlier: replaced(2, pingAnswer('server-ping-1'), pingAnswer('server-ping-1'))
    },
    {
      label: 'two pings with one id, answered once',
      earlier: replaced(1, initialize([serverPing(), serverPing()]))
    },
    {
      label: 'an answer sent before the ping',
      earlier: [
        probe,
        pingAnswer('server-ping-1'),
        initialize([serverPing()]),
        initialized,
        standingGet(),
        listing()
      ]
    },
    {
      label: 'an answer with no ping at all',
      earlier: [probe, initialize([]), pingAnswer('x'), initialized, standingGet(), listing()]
    },
    {
      label: 'a ping with params',
      earlier: replaced(1, initialize([{ ...serverPing(), params: { reason: 'synthetic' } }]))
    },
    {
      label: 'a ping with _meta params',
      earlier: replaced(1, initialize([{ ...serverPing(), params: { _meta: {} } }]))
    },
    {
      label: 'a ping with null params',
      earlier: replaced(1, initialize([{ ...serverPing(), params: null }]))
    },
    {
      label: 'a ping with an extra member',
      earlier: replaced(1, initialize([{ ...serverPing(), result: {} }]))
    },
    {
      label: 'a ping without jsonrpc',
      earlier: replaced(1, initialize([{ id: 'server-ping-1', method: 'ping' }]))
    },
    {
      label: 'a ping on the standing GET',
      earlier: replaced(4, standingGet(ssePayloads([serverPing()])))
    },
    ...otherRequests.map(request => ({
      label: `a ${String(request['method'])} request answered with an accepted empty result`,
      earlier: replaced(1, initialize([request]))
    }))
  ]

  for (const { label, earlier } of refused) {
    it(`refuses (uncertain-exchange): ${label}`, () => {
      expect(verdictOf(earlier)).toBe('uncertain-exchange')
    })
  }
})

describe('eventsource-parser is the copy the client parses with', () => {
  it("declares the client's range and resolves the same copy and version in this repository", () => {
    const own = createRequire(import.meta.url)
    const clientEntry = own.resolve('@modelcontextprotocol/client')
    const fromClient = createRequire(clientEntry)

    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    )

    const clientManifest = JSON.parse(
      readFileSync(new URL('../package.json', pathToFileURL(clientEntry)), 'utf8')
    )

    const clientParser = realpathSync(fromClient.resolve('eventsource-parser/package.json'))
    const ownParser = realpathSync(own.resolve('eventsource-parser/package.json'))

    expect(manifest.dependencies['eventsource-parser']).toBe(
      clientManifest.dependencies['eventsource-parser']
    )
    expect(ownParser).toBe(clientParser)
    expect(JSON.parse(readFileSync(ownParser, 'utf8')).version).toBe('3.0.8')
  })
})

/** The events the client's real pipeline dispatches for `bytes` (one byte chunk, as buffered). */
const pipelineEvents = (bytes: Uint8Array<ArrayBuffer>) =>
  Effect.promise(async () => {
    const events: Array<{ readonly event: string | undefined; readonly data: string }> = []
    const body = new Response(bytes).body

    if (body === null) {
      return events
    }

    const reader = body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream())
      .getReader()

    for (;;) {
      const { value, done } = await reader.read()

      if (done) {
        return events
      }

      events.push({ event: value.event, data: value.data })
    }
  })

const utf8 = (text: string) => new TextEncoder().encode(text)

const withBytes = (text: string, ...trailing: ReadonlyArray<number>) =>
  new Uint8Array([...utf8(text), ...trailing])

const safeListing = (id: number) =>
  JSON.stringify({ jsonrpc: '2.0', id, result: page([...mcpConformanceSyntheticTools]) })

const byteAnswer = (bytes: Uint8Array): WireResponse => ({
  status: 200,
  headers: { 'content-type': 'text/event-stream' },
  chunks: [{ base64: Buffer.from(bytes).toString('base64') }]
})

describe('SSE bytes are decoded and parsed as the client does (decoder flush included)', () => {
  const samples: ReadonlyArray<{
    readonly label: string
    readonly bytes: Uint8Array<ArrayBuffer>
  }> = [
    {
      label: 'an incomplete sequence after a pending CR (two responses, one dispatched)',
      bytes: withBytes(`data: ${safeListing(0)}\n\ndata: ${safeListing(0)}\n\r`, 0xc2)
    },
    {
      label: 'a lone CR then an incomplete sequence (nothing dispatched)',
      bytes: withBytes('data: X\n\r', 0xe2)
    },
    { label: 'the first-chunk marker', bytes: withBytes(`${firstChunkMarker}data: X\n\n`) },
    { label: 'a real BOM', bytes: withBytes('\uFEFFdata: X\n\n') },
    { label: 'a terminal bare CR', bytes: withBytes('data: X\n\ndata: not json\r\r') },
    { label: 'an unterminated final event', bytes: withBytes('data: X\n\ndata: Y') },
    {
      label: 'priming and other event types',
      bytes: withBytes('id: 1\ndata: \n\nevent: ping\ndata: p\n\nevent: message\ndata: X\n\n')
    }
  ]

  for (const { label, bytes } of samples) {
    it.effect(`matches the real pipeline: ${label}`, () =>
      Effect.gen(function* () {
        const events = yield* pipelineEvents(bytes)
        const feeds = decodeAsTextDecoderStream(bytes, true)

        expect(sseAllPayloads(feeds)).toEqual(
          events.filter(event => event.data.length > 0).map(event => event.data)
        )
        expect(sseMessagePayloads(feeds)).toEqual(
          events
            .filter(
              event =>
                event.data.length > 0 && (event.event === undefined || event.event === 'message')
            )
            .map(event => event.data)
        )
      })
    )
  }

  it.effect(
    'forwards a safe call when a duplicate response is held back by the decoder flush',
    () =>
      Effect.gen(function* () {
        const ledger = yield* Ref.make<ReplayLedgerApi | undefined>(undefined)

        yield* mcpUnknownToolCase.run.pipe(
          Effect.provide(
            replayLayer(
              [
                withResponse(
                  mcpUnknownToolModernFixture,
                  lastIndexOf(mcpUnknownToolModernFixture, 'tools/list'),
                  byteAnswer(
                    withBytes(`data: ${safeListing(0)}\n\ndata: ${safeListing(0)}\n\r`, 0xc2)
                  )
                )
              ],
              'modern',
              { ledger }
            )
          )
        )

        expect(yield* ledgerMethods(ledger)).toContain('tools/call')
      })
  )

  it.effect('response-encoding sees one response where the client dispatches one', () =>
    passAgainst(
      mcpResponseEncodingCase,
      withResponse(
        mcpResponseEncodingModernFixture,
        lastIndexOf(mcpResponseEncodingModernFixture, 'tools/list'),
        byteAnswer(withBytes(`data: ${safeListing(0)}\n\ndata: ${safeListing(0)}\n\r`, 0xc2))
      )
    )
  )

  it.effect('response-encoding sees no response where the client dispatches none', () =>
    Effect.gen(function* () {
      const error = yield* mcpResponseEncodingCase.run.pipe(
        Effect.provide(
          replayLayer(
            [
              withResponse(
                mcpResponseEncodingModernFixture,
                lastIndexOf(mcpResponseEncodingModernFixture, 'tools/list'),
                byteAnswer(withBytes(`data: ${safeListing(0)}\n\r`, 0xe2))
              )
            ],
            'modern',
            { target: { timeoutMs: 300 } }
          )
        ),
        Effect.flip
      )

      expect(error.message).toBe(
        'expected the event stream answering POST tools/list to hold its response once'
      )
    })
  )
})

describe('answers read as the SDK reads them', () => {
  it.effect('a discover result with ttlMs: 1e400 stays modern (the client catches ttlMs)', () =>
    passAgainst(
      mcpNegotiationEraCase,
      withResponse(
        mcpNegotiationEraModernFixture,
        0,
        jsonAnswer(
          JSON.stringify({
            jsonrpc: '2.0',
            id: mcpConformanceDiscoverRequestId,
            result: mcpConformanceModernDiscoverResult
          }).replace('"ttlMs":0', '"ttlMs":1e400')
        )
      )
    )
  )

  it.effect(
    'a discover result with resultType: 42 stays modern (the dispatch schema ignores it)',
    () =>
      passAgainst(
        mcpNegotiationEraCase,
        withResponse(
          mcpNegotiationEraModernFixture,
          0,
          jsonAnswer(
            JSON.stringify({
              jsonrpc: '2.0',
              id: mcpConformanceDiscoverRequestId,
              result: { ...mcpConformanceModernDiscoverResult, resultType: 42 }
            })
          )
        )
      )
  )

  it.effect('a final bare CR after a data line ends no event (the parser keeps it pending)', () =>
    passAgainst(
      mcpResponseEncodingCase,
      withStreams(mcpResponseEncodingLegacyFixture, chunks => [...chunks, 'data: not json\r\r'])
    )
  )
})
