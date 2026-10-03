/**
 * The Afloat MCP conformance target, seeds, and derived fixtures, replayed through the generic
 * cases of `@yolk-sdk/mcp/conformance` (a devDependency: the connectors package never imports
 * `@yolk-sdk/mcp` at runtime). The target is produced by running the REAL `afloat.mcp_auth`
 * action over `staticCredentialResolverLayer`; every applicable case runs the real
 * `@yolk-sdk/mcp/client` behind its observing client and fail-closed call gate; one drill per
 * case makes exactly that case disagree.
 */
import { Effect, Layer, Option, Predicate, Ref } from 'effect'
import * as Schema from 'effect/Schema'
import { HttpClient } from 'effect/http'
import { describe, expect, it } from '@effect/vitest'
import {
  decodeWireFixture,
  isWireStreamResponse,
  scanFixtureForSecrets,
  type WireExchange,
  type WireFixture,
  type WireResponse
} from '@yolk-sdk/conformance/fixture'
import { makeReplayHttpClient, type ReplayLedgerApi } from '@yolk-sdk/conformance/replay'
import {
  conformanceReportFailed,
  formatConformanceReport,
  runConformance
} from '@yolk-sdk/conformance/runner'
import { latestMcpProtocolVersion } from '@yolk-sdk/mcp/client'
import {
  McpConformanceConfig,
  McpConformanceTarget,
  mcpConformanceCases,
  mcpConformanceDefaultAbsentToolName,
  mcpConformanceDiscoverRequestId,
  mcpConformanceSyntheticEnvelope,
  mcpObservedRequestHeaders,
  selectMcpConformanceCases,
  type McpConformanceCase,
  type McpConformanceSeeds
} from '@yolk-sdk/mcp/conformance'
import { ApiKeyCredential, ConnectorError } from '@yolk-sdk/connectors'
import { afloatMcpServerUrl } from '@yolk-sdk/connectors/afloat'
import {
  afloatMcpConformanceEnvelope,
  afloatMcpConformanceExpectedTools,
  afloatMcpConformanceFixtureFor,
  afloatMcpConformanceFixtureSeeds,
  afloatMcpConformanceFixtures,
  afloatMcpConformanceInvalidCredential,
  afloatMcpConformanceLiveSeeds,
  afloatMcpConformanceNotApplicable,
  afloatMcpConformanceNotReadOnly,
  afloatMcpConformanceReadCall,
  afloatMcpConformanceTools,
  makeAfloatMcpConformanceTarget,
  type AfloatMcpConformanceTargetSettings
} from '@yolk-sdk/connectors/afloat/conformance'
import { staticCredentialResolverLayer } from '@yolk-sdk/connectors/conformance'

const now = new Date('2026-10-02T12:00:00.000Z')

/** A synthetic Afloat key (never valid anywhere; replay never checks it). */
const syntheticKey = 'afloat_synthetic-replay-key-0001'

const { applicable, notApplicable } = selectMcpConformanceCases(mcpConformanceCases, 'modern')

/** The target, built by running the real `afloat.mcp_auth` over a static credential. */
const targetFor = (key: string) =>
  makeAfloatMcpConformanceTarget().pipe(
    Effect.provide(staticCredentialResolverLayer(ApiKeyCredential.make({ key })))
  )

const fixtureOf = (testCase: Pick<McpConformanceCase, 'id'>): WireFixture => {
  const fixture = afloatMcpConformanceFixtureFor(testCase.id)

  if (fixture === undefined) {
    throw new Error(`no Afloat fixture for ${testCase.id}`)
  }

  return fixture
}

const replayLayer = (
  fixtures: ReadonlyArray<WireFixture>,
  options: {
    readonly seeds?: McpConformanceSeeds
    readonly ledger?: Ref.Ref<ReplayLedgerApi | undefined>
  } = {}
) =>
  Layer.mergeAll(
    Layer.unwrap(
      makeReplayHttpClient(fixtures).pipe(
        Effect.tap(({ ledger }) =>
          options.ledger === undefined ? Effect.void : Ref.set(options.ledger, ledger)
        ),
        Effect.map(({ client }) => Layer.succeed(HttpClient.HttpClient, client))
      )
    ),
    Layer.effect(McpConformanceTarget, targetFor(syntheticKey)),
    Layer.succeed(McpConformanceConfig, options.seeds ?? afloatMcpConformanceFixtureSeeds)
  )

const isRecord = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

const rpcMethod = (exchange: WireExchange): string | undefined => {
  const body = exchange.request.body

  return isRecord(body) && Predicate.isString(body['method']) ? body['method'] : undefined
}

const bodyText = (response: WireResponse): string =>
  Predicate.hasProperty(response, 'body') && Predicate.isString(response.body) ? response.body : ''

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

/** JSON text as a value (`null` when it is not JSON, which every caller then rejects). */
const decodeJsonText = (text: string): Schema.Json =>
  Option.getOrElse(decodeJson(text), (): Schema.Json => null)

const parsed = (response: WireResponse): Schema.Json => decodeJsonText(bodyText(response))

/** A copy of `fixture` whose exchanges are changed by `f` (a drill). */
const drilled = (
  fixture: WireFixture,
  f: (exchange: WireExchange) => WireExchange
): WireFixture => {
  const [first, ...rest] = fixture.exchanges.map(f)

  if (first === undefined) {
    throw new Error('empty fixture')
  }

  return { ...fixture, exchanges: [first, ...rest] }
}

/** Change the JSON answer of every exchange whose JSON-RPC method is `method`. */
const answerOf =
  (method: string, change: (response: WireResponse) => WireResponse) =>
  (exchange: WireExchange): WireExchange =>
    rpcMethod(exchange) === method ? { ...exchange, response: change(exchange.response) } : exchange

const withBody = (response: WireResponse, body: Schema.Json): WireResponse => ({
  status: response.status,
  headers: response.headers,
  body: JSON.stringify(body)
})

/** Change the `result` member of a JSON answer. */
const mapResult =
  (change: (result: Schema.JsonObject) => Schema.Json) =>
  (response: WireResponse): WireResponse => {
    const message = parsed(response)
    const result = isRecord(message) ? message['result'] : undefined

    if (!isRecord(message) || !isRecord(result)) {
      return response
    }

    return withBody(response, { ...message, result: change(result) })
  }

describe('the Afloat target is the real afloat.mcp_auth output', () => {
  it.effect('modern 2026-07-28 on the provider endpoint, Authorization: Bearer <key>', () =>
    Effect.gen(function* () {
      const target: AfloatMcpConformanceTargetSettings = yield* targetFor(syntheticKey)

      expect(target).toEqual({
        name: 'afloat',
        url: 'https://useafloat.com/mcp',
        headers: { authorization: `Bearer ${syntheticKey}` },
        era: 'modern',
        protocolVersion: latestMcpProtocolVersion,
        timeoutMs: 30_000,
        invalidCredentialHeaders: {
          authorization: `Bearer ${afloatMcpConformanceInvalidCredential}`
        }
      })
      expect(afloatMcpConformanceInvalidCredential.startsWith('afloat_')).toBe(true)
    })
  )

  it.effect('a key without the afloat_ prefix never becomes a target', () =>
    Effect.gen(function* () {
      const error = yield* targetFor('synthetic-key-without-prefix').pipe(Effect.flip)

      expect(error).toBeInstanceOf(ConnectorError)
      expect(error).toMatchObject({ cause: 'credential_invalid' })
    })
  )
})

describe('Afloat MCP fixtures', () => {
  it('one derived fixture per case of the modern era; mcp.legacy.session does not apply', () => {
    expect(afloatMcpConformanceFixtures.map(fixture => fixture.caseId)).toEqual(
      applicable.map(testCase => testCase.id)
    )
    expect(afloatMcpConformanceNotApplicable.map(entry => entry.id)).toEqual(
      notApplicable.map(entry => entry.id)
    )
    expect(new Set(afloatMcpConformanceFixtures.map(fixture => fixture.id)).size).toBe(
      afloatMcpConformanceFixtures.length
    )

    for (const fixture of afloatMcpConformanceFixtures) {
      expect(fixture.id).toBe(`${fixture.caseId}.afloat.synthetic`)
      expect(fixture.note).toContain(
        'Derived from the provider source (owner-supplied), not a live recording'
      )
    }
  })

  it.effect('decode, pass the shared secret scan, and stay synthetic', () =>
    Effect.gen(function* () {
      for (const fixture of afloatMcpConformanceFixtures) {
        expect((yield* decodeWireFixture(fixture)).id).toBe(fixture.id)
        expect(scanFixtureForSecrets(fixture), fixture.id).toEqual([])
        expect(fixture).toMatchObject({
          evidence: 'unverified',
          account: 'synthetic',
          endpoint: afloatMcpServerUrl
        })

        for (const { request, response } of fixture.exchanges) {
          expect(request.method).toBe('POST')
          expect(request.url).toBe(afloatMcpServerUrl)
          expect(
            Object.keys(request.headers ?? {}).every(name =>
              mcpObservedRequestHeaders.includes(name)
            )
          ).toBe(true)
          expect(request.headers?.['mcp-protocol-version']).toBe(latestMcpProtocolVersion)
          expect(isWireStreamResponse(response)).toBe(false)
          expect(response.headers['mcp-session-id']).toBeUndefined()
          expect(response.headers['content-type']).toBe('application/json')
          // Canonical JSON: the emulator substitutes ids in these bytes.
          expect(JSON.stringify(parsed(response))).toBe(bodyText(response))
        }
      }

      const serialized = JSON.stringify(afloatMcpConformanceFixtures)

      expect(serialized).not.toMatch(/"authorization"/i)
      expect(serialized).not.toContain(afloatMcpConformanceInvalidCredential)
      expect(serialized).not.toContain(syntheticKey)
    })
  )

  it('the shared scan flags an Afloat-shaped key', () => {
    const [fixture] = afloatMcpConformanceFixtures

    if (fixture === undefined) {
      return expect.fail('no fixture')
    }

    const leaked = { ...fixture, note: `key afloat_${'0123456789abcdef'.repeat(4)}` }

    expect(scanFixtureForSecrets(leaked)).not.toEqual([])
  })

  it('requests carry the client envelope and the probe id of the pinned SDK', () => {
    expect(afloatMcpConformanceEnvelope).toEqual(mcpConformanceSyntheticEnvelope)

    const probe = afloatMcpConformanceFixtures[0]?.exchanges[0]?.request.body

    expect(isRecord(probe) ? probe['id'] : undefined).toBe(mcpConformanceDiscoverRequestId)
  })

  it('the listing publishes the tool subset with the provider annotations', () => {
    const names = afloatMcpConformanceTools.map(tool => tool['name'])

    expect(names).toEqual(afloatMcpConformanceExpectedTools)
    expect(afloatMcpConformanceLiveSeeds).toEqual({
      expectedTools: afloatMcpConformanceExpectedTools,
      notReadOnly: afloatMcpConformanceNotReadOnly
    })
    expect(afloatMcpConformanceLiveSeeds.readTool).toBeUndefined()

    const readOnly = (name: string) => {
      const tool = afloatMcpConformanceTools.find(candidate => candidate['name'] === name)
      const annotations = tool?.['annotations']

      return isRecord(annotations) ? annotations['readOnlyHint'] : undefined
    }

    expect(afloatMcpConformanceNotReadOnly.map(readOnly)).toEqual([false, false])
    expect(readOnly(afloatMcpConformanceReadCall.name)).toBe(true)

    for (const tool of afloatMcpConformanceTools) {
      expect(Object.keys(tool)).toEqual([
        'name',
        'title',
        'description',
        'inputSchema',
        'outputSchema',
        'annotations'
      ])
    }

    // The listing every fixture records is exactly the published subset.
    for (const fixture of afloatMcpConformanceFixtures) {
      for (const exchange of fixture.exchanges.filter(entry => rpcMethod(entry) === 'tools/list')) {
        const message = parsed(exchange.response)
        const result = isRecord(message) ? message['result'] : undefined

        expect(isRecord(result) ? result['tools'] : undefined).toEqual(afloatMcpConformanceTools)
      }
    }
  })

  it('every tools/call answer is a minimal synthetic body (allowlist)', () => {
    // The only words, ids, and values a tools/call answer may hold.
    const words = new Set([
      'ISSUED',
      'PAID',
      'EUR',
      'SYN-',
      'Synthetic Customer',
      'VALIDATION_ERROR',
      'The tool arguments did not match the expected schema.',
      'Requested tool was not found',
      'text',
      'complete',
      'afloat',
      '2.0.0',
      '2.0'
    ])

    const allowedString = (value: string) =>
      words.has(value) ||
      /^yolksynthetic[a-z]+0*1$/.test(value) ||
      /^\d+$/.test(value) ||
      /^2026-01-\d{2}(T12:00:00\.000Z)?$/.test(value) ||
      value === '' ||
      /^00000000-0000-4000-8000-00000000000\d$/.test(value)

    // The only keys: the envelope, the tool result, the invoice page the read call decodes, and
    // the provider's error body.
    const keys = new Set([
      'jsonrpc',
      'id',
      'result',
      'error',
      'code',
      'message',
      'requestId',
      'content',
      'type',
      'text',
      'structuredContent',
      'isError',
      'resultType',
      '_meta',
      'io.modelcontextprotocol/serverInfo',
      'name',
      'version',
      'items',
      'totalCount',
      'invoiceNumber',
      'status',
      'computedStatus',
      'invoiceDate',
      'invoiceDueDays',
      'currency',
      'taxPercentage',
      'itemsValue',
      'invoiceValue',
      'paymentDate',
      'paymentValue',
      'paymentCurrency',
      'purchaseOrder',
      'notes',
      'customer',
      'sequence',
      'prefix',
      'suffix',
      'updatedAt'
    ])

    const refusals = (value: Schema.Json): ReadonlyArray<string> => {
      if (Predicate.isString(value)) {
        // Tool results carry their structured content as JSON text too.
        return value.startsWith('{')
          ? refusals(decodeJsonText(value))
          : allowedString(value)
            ? []
            : [value]
      }

      if (Array.isArray(value)) return value.flatMap(refusals)

      return isRecord(value)
        ? Object.entries(value).flatMap(([key, item]) => [
            ...(keys.has(key) ? [] : [`key ${key}`]),
            ...refusals(item)
          ])
        : []
    }

    for (const fixture of afloatMcpConformanceFixtures) {
      for (const exchange of fixture.exchanges.filter(entry => rpcMethod(entry) === 'tools/call')) {
        expect(refusals(parsed(exchange.response)), fixture.id).toEqual([])
      }
    }
  })
})

describe('Afloat MCP cases on replay', () => {
  it.effect('every applicable case passes with unverified warnings', () =>
    Effect.gen(function* () {
      const report = yield* runConformance(applicable, {
        target: { kind: 'replay' },
        now,
        fixtures: afloatMcpConformanceFixtures,
        layer: testCase => replayLayer([fixtureOf(testCase)])
      })

      expect(report.summary, formatConformanceReport(report)).toEqual({
        passed: applicable.length,
        failed: 0,
        skipped: 0
      })
      expect(conformanceReportFailed(report)).toBe(false)
      expect(
        report.results.every(result =>
          result.warnings.some(warning => warning.kind === 'unverified-case')
        )
      ).toBe(true)
    })
  )

  it.effect("send exactly the fixture requests, in the SDK's order", () =>
    Effect.gen(function* () {
      for (const testCase of applicable) {
        const fixture = fixtureOf(testCase)
        const ledger = yield* Ref.make<ReplayLedgerApi | undefined>(undefined)

        yield* testCase.run.pipe(Effect.provide(replayLayer([fixture], { ledger })))

        const api = yield* Ref.get(ledger)

        if (api === undefined) {
          return expect.fail('no ledger')
        }

        expect(yield* api.remaining, testCase.id).toEqual([])

        const entries = yield* api.entries

        expect(entries).toHaveLength(fixture.exchanges.length)

        for (const [index, entry] of entries.entries()) {
          if (entry.match.outcome !== 'matched') {
            return expect.fail(`${testCase.id}: unmatched ${entry.method} ${entry.url}`)
          }

          expect(entry.match.exchangeIndex, testCase.id).toBe(index)

          const recorded = fixture.exchanges[index]?.request

          expect(entry.bodyJson, `${testCase.id} #${index}`).toEqual(recorded?.body)

          for (const name of mcpObservedRequestHeaders) {
            expect(entry.headers[name], `${testCase.id} #${index} ${name}`).toBe(
              recorded?.headers?.[name]
            )
          }

          expect(entry.headers['authorization'] ?? '<redacted>').toBe('<redacted>')
        }
      }
    })
  )

  it.effect('without readTool, the call cases fail their precondition and send nothing', () =>
    Effect.gen(function* () {
      const calling = applicable.filter(testCase =>
        ['mcp.tools.call-read', 'mcp.tools.call-tool-error'].includes(testCase.id)
      )

      const report = yield* runConformance(calling, {
        target: { kind: 'replay' },
        now,
        layer: testCase =>
          replayLayer([fixtureOf(testCase)], { seeds: afloatMcpConformanceLiveSeeds })
      })

      expect(report.results.map(result => result.failure?.message)).toEqual([
        expect.stringContaining('precondition: McpConformanceConfig.readTool is not configured'),
        expect.stringContaining('precondition: McpConformanceConfig.readTool is not configured')
      ])
    })
  )
})

type Drill = {
  readonly id: string
  readonly change: (exchange: WireExchange) => WireExchange
  readonly message: string
}

const drills: ReadonlyArray<Drill> = [
  {
    id: 'mcp.negotiation.era',
    change: answerOf(
      'server/discover',
      mapResult(result => ({ ...result, supportedVersions: ['2025-11-25'] }))
    ),
    message: 'expected the era probe answer to select the modern era'
  },
  {
    id: 'mcp.modern.stateless',
    change: answerOf(
      'server/discover',
      mapResult(({ resultType: _resultType, ...result }) => result)
    ),
    message: 'expected resultType: "complete" on the result of POST server/discover'
  },
  {
    id: 'mcp.transport.response-encoding',
    change: answerOf('tools/list', response => ({
      ...response,
      headers: { 'content-type': 'text/plain' }
    })),
    message: 'expected the answer to POST tools/list to be application/json or text/event-stream'
  },
  {
    id: 'mcp.tools.list',
    change: answerOf(
      'tools/list',
      mapResult(result => {
        const tools = result['tools']

        return {
          ...result,
          tools: (Array.isArray(tools) ? tools : []).map(tool => {
            const annotations = isRecord(tool) ? tool['annotations'] : undefined

            return isRecord(tool) && tool['name'] === 'create-receipt-upload'
              ? {
                  ...tool,
                  annotations: isRecord(annotations)
                    ? { ...annotations, readOnlyHint: true }
                    : { readOnlyHint: true }
                }
              : tool
          })
        }
      })
    ),
    message: 'expected no notReadOnly tool to be marked readOnlyHint: true'
  },
  {
    id: 'mcp.tools.call-read',
    change: answerOf(
      'tools/call',
      mapResult(result => ({ ...result, isError: true }))
    ),
    message: 'expected the read call result to have isError absent or false'
  },
  {
    id: 'mcp.tools.call-tool-error',
    change: answerOf('tools/call', response =>
      withBody(response, {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32_602, message: 'Synthetic drill error.' }
      })
    ),
    message:
      'expected invalid arguments to answer a tool result with isError: true, not a JSON-RPC error'
  },
  {
    id: 'mcp.errors.unknown-tool',
    change: answerOf('tools/call', response =>
      withBody(response, {
        result: { content: [{ type: 'text', text: 'Synthetic drill.' }], resultType: 'complete' },
        jsonrpc: '2.0',
        id: 1
      })
    ),
    message: 'expected tools/call of an absent tool not to answer a result'
  },
  {
    id: 'mcp.auth.rejected',
    change: answerOf('server/discover', response => ({
      ...response,
      headers: { 'content-type': 'application/json' }
    })),
    // The runner's message sanitizer redacts the word after `Bearer`.
    message: 'expected the 401 to carry a WWW-Authenticate: Bearer <redacted>'
  }
]

describe('disagreement drills: each fails exactly its case', () => {
  it('has one drill per applicable case', () => {
    expect(drills.map(drill => drill.id)).toEqual(applicable.map(testCase => testCase.id))
    expect(mcpConformanceDefaultAbsentToolName).toBe('yolk_conformance_absent')
  })

  for (const drill of drills) {
    it.effect(`${drill.id} fails on its drilled fixture`, () =>
      Effect.gen(function* () {
        const testCase = applicable.find(candidate => candidate.id === drill.id)

        if (testCase === undefined) {
          return expect.fail(`no case ${drill.id}`)
        }

        const report = yield* runConformance([testCase], {
          target: { kind: 'replay' },
          now,
          layer: () => replayLayer([drilled(fixtureOf(testCase), drill.change)])
        })

        expect(report.summary, formatConformanceReport(report)).toEqual({
          passed: 0,
          failed: 1,
          skipped: 0
        })
        expect(report.results[0]?.failure?.tag).toBe('ConformanceMismatch')
        expect(report.results[0]?.failure?.message).toContain(drill.message)
      })
    )
  }
})
