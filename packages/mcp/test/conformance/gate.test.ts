/**
 * The fail-closed call gate: every calling case forwards a `tools/call` only on positive evidence
 * from the call operation's own listing, and refuses (with zero forwarded calls) on anything else.
 * Also the parsing edge cases the SDK reads with `JSON.parse` and `eventsource-parser`.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Deferred, Effect, Layer, Predicate, Ref } from 'effect'
import * as Schema from 'effect/Schema'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { describe, expect, it } from '@effect/vitest'
import type { WireExchange, WireFixture, WireResponse } from '@yolk-sdk/conformance/fixture'
import type { ReplayLedgerApi } from '@yolk-sdk/conformance/replay'
import { EventSourceParserStream } from 'eventsource-parser/stream'
import {
  mcpCallReadCase,
  mcpCallReadModernFixture,
  mcpCallToolErrorCase,
  mcpCallToolErrorModernFixture,
  mcpConformanceDiscoverRequestId,
  mcpConformanceLegacyInitializeResult,
  mcpConformanceModernDiscoverResult,
  mcpConformanceSyntheticModernUrl,
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
  mcpUnknownToolModernFixture,
  modernCallExchanges,
  modernListingExchanges,
  type McpConformanceCase
} from '../../src/conformance/index.ts'
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

  it.effect('an incomplete multi-page listing (a repeated cursor stops the SDK early)', () =>
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
        { ...firstList, response: listAnswer(1, [mcpConformanceSyntheticWriteTool], 'cursor-1') },
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
