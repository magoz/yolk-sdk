/**
 * The Figma MCP conformance target, seeds, and synthetic fixtures, replayed through the generic
 * cases of `@yolk-sdk/mcp/conformance` (a devDependency: the connectors package never imports
 * `@yolk-sdk/mcp` at runtime). The target is produced by running the REAL `figma.mcp_auth` action
 * over `staticCredentialResolverLayer`; every applicable (legacy-era) case runs the real
 * `@yolk-sdk/mcp/client` behind its observing client and fail-closed call gate; one drill per case
 * makes exactly that case disagree.
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
import {
  McpConformanceConfig,
  McpConformanceTarget,
  mcpConformanceCases,
  mcpConformanceDiscoverRequestId,
  mcpConformanceInvalidCredential,
  mcpConformanceSyntheticEnvelope,
  mcpConformanceSyntheticLegacyProtocolVersion,
  mcpObservedRequestHeaders,
  selectMcpConformanceCases,
  type McpConformanceCase,
  type McpConformanceSeeds
} from '@yolk-sdk/mcp/conformance'
import {
  ApiKeyCredential,
  BearerTokenCredential,
  ConnectorError,
  OAuthCredential
} from '@yolk-sdk/connectors'
import { figmaMcpServerUrl } from '@yolk-sdk/connectors/figma'
import {
  figmaMcpConformanceExpectedTools,
  figmaMcpConformanceFixtureFor,
  figmaMcpConformanceFixtureSeeds,
  figmaMcpConformanceFixtures,
  figmaMcpConformanceInvalidCredential,
  figmaMcpConformanceLiveSeeds,
  figmaMcpConformanceNotApplicable,
  figmaMcpConformanceNotReadOnly,
  figmaMcpConformanceProbeEnvelope,
  figmaMcpConformanceProtocolVersion,
  figmaMcpConformanceReadCall,
  figmaMcpConformanceTools,
  makeFigmaMcpConformanceTarget,
  type FigmaMcpConformanceTargetSettings
} from '@yolk-sdk/connectors/figma/conformance'
import { staticCredentialResolverLayer } from '@yolk-sdk/connectors/conformance'

const now = new Date('2026-11-20T12:00:00.000Z')

/** A synthetic Figma access token (never valid anywhere; replay never checks it). */
const syntheticToken = 'synthetic-figma-replay-token-0001'

/** Synthetic OAuth client credentials: the target must never send them. */
const syntheticRefreshToken = 'synthetic-figma-refresh-token-0001'

const syntheticClientSecret = 'synthetic-figma-client-secret-0001'

const { applicable, notApplicable } = selectMcpConformanceCases(mcpConformanceCases, 'legacy')

const oauthCredential = OAuthCredential.make({
  provider: 'figma',
  accessToken: syntheticToken,
  expiresAt: 1_900_000_000_000,
  refreshToken: syntheticRefreshToken,
  clientId: 'synthetic-figma-client-0001',
  clientSecret: syntheticClientSecret
})

/** The target, built by running the real `figma.mcp_auth` over a static OAuth credential. */
const target = makeFigmaMcpConformanceTarget().pipe(
  Effect.provide(staticCredentialResolverLayer(oauthCredential))
)

const fixtureOf = (testCase: Pick<McpConformanceCase, 'id'>): WireFixture => {
  const fixture = figmaMcpConformanceFixtureFor(testCase.id)

  if (fixture === undefined) {
    throw new Error(`no Figma fixture for ${testCase.id}`)
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
    Layer.effect(McpConformanceTarget, target),
    Layer.succeed(McpConformanceConfig, options.seeds ?? figmaMcpConformanceFixtureSeeds)
  )

const isRecord = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value)

const rpcMethod = (exchange: WireExchange): string | undefined => {
  const body = exchange.request.body

  return isRecord(body) && Predicate.isString(body['method']) ? body['method'] : undefined
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

const decodeJsonText = (text: string): Schema.Json =>
  Option.getOrElse(decodeJson(text), (): Schema.Json => null)

const dataPrefix = 'data: '

/** The JSON-RPC messages of an answer: a JSON body, or every SSE `data:` payload. */
const messagesOf = (response: WireResponse): ReadonlyArray<Schema.Json> => {
  if (isWireStreamResponse(response)) {
    return response.chunks.flatMap(chunk =>
      Predicate.isString(chunk)
        ? chunk
            .split('\n')
            .filter(line => line.startsWith(dataPrefix))
            .map(line => decodeJsonText(line.slice(dataPrefix.length)))
        : []
    )
  }

  return Predicate.hasProperty(response, 'body') && Predicate.isString(response.body)
    ? response.body === ''
      ? []
      : [decodeJsonText(response.body)]
    : []
}

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

/** Change the answer of every exchange whose JSON-RPC method is `method`. */
const answerOf =
  (method: string, change: (response: WireResponse) => WireResponse) =>
  (exchange: WireExchange): WireExchange =>
    rpcMethod(exchange) === method ? { ...exchange, response: change(exchange.response) } : exchange

/** Replace the JSON-RPC message of an SSE answer (every `data:` line) with `change` of it. */
const mapSseMessage =
  (change: (message: Schema.JsonObject) => Schema.Json) =>
  (response: WireResponse): WireResponse => {
    if (!isWireStreamResponse(response)) return response

    return {
      ...response,
      chunks: response.chunks.map(chunk =>
        Predicate.isString(chunk)
          ? chunk
              .split('\n')
              .map(line => {
                if (!line.startsWith(dataPrefix)) return line

                const message = decodeJsonText(line.slice(dataPrefix.length))

                return isRecord(message) ? `${dataPrefix}${JSON.stringify(change(message))}` : line
              })
              .join('\n')
          : chunk
      )
    }
  }

/** Change the `result` member of an SSE answer. */
const mapResult = (change: (result: Schema.JsonObject) => Schema.Json) =>
  mapSseMessage(message => {
    const result = message['result']

    return isRecord(result) ? { ...message, result: change(result) } : message
  })

describe('the Figma target is the real figma.mcp_auth output', () => {
  it.effect(
    'legacy 2025-11-25 on the provider endpoint, Authorization: Bearer <access token>',
    () =>
      Effect.gen(function* () {
        const settings: FigmaMcpConformanceTargetSettings = yield* target

        expect(settings).toEqual({
          name: 'figma',
          url: 'https://mcp.figma.com/mcp',
          headers: { authorization: `Bearer ${syntheticToken}` },
          era: 'legacy',
          protocolVersion: mcpConformanceSyntheticLegacyProtocolVersion,
          timeoutMs: 30_000,
          invalidCredentialHeaders: {
            authorization: `Bearer ${mcpConformanceInvalidCredential}`
          }
        })
        expect(figmaMcpConformanceInvalidCredential).toBe(mcpConformanceInvalidCredential)
        expect(figmaMcpConformanceProtocolVersion).toBe(
          mcpConformanceSyntheticLegacyProtocolVersion
        )

        // The refresh token and the client credentials never reach the target.
        const serialized = JSON.stringify(settings)

        expect(serialized).not.toContain(syntheticRefreshToken)
        expect(serialized).not.toContain(syntheticClientSecret)
      })
  )

  it.effect('a bearer token credential becomes a target too', () =>
    Effect.gen(function* () {
      const settings = yield* makeFigmaMcpConformanceTarget().pipe(
        Effect.provide(
          staticCredentialResolverLayer(BearerTokenCredential.make({ token: syntheticToken }))
        )
      )

      expect(settings.headers).toEqual({ authorization: `Bearer ${syntheticToken}` })
    })
  )

  it.effect('an API key credential never becomes a target', () =>
    Effect.gen(function* () {
      const error = yield* makeFigmaMcpConformanceTarget().pipe(
        Effect.provide(staticCredentialResolverLayer(ApiKeyCredential.make({ key: 'synthetic' }))),
        Effect.flip
      )

      expect(error).toBeInstanceOf(ConnectorError)
      expect(error).toMatchObject({ cause: 'credential_invalid' })
    })
  )
})

describe('Figma MCP fixtures', () => {
  it('one synthetic fixture per case of the legacy era; mcp.modern.stateless does not apply', () => {
    expect(figmaMcpConformanceFixtures.map(fixture => fixture.caseId)).toEqual(
      applicable.map(testCase => testCase.id)
    )
    expect(figmaMcpConformanceNotApplicable.map(entry => entry.id)).toEqual(
      notApplicable.map(entry => entry.id)
    )
    expect(new Set(figmaMcpConformanceFixtures.map(fixture => fixture.id)).size).toBe(
      figmaMcpConformanceFixtures.length
    )

    for (const fixture of figmaMcpConformanceFixtures) {
      expect(fixture.id).toBe(`${fixture.caseId}.figma.synthetic`)
      expect(fixture.note).toContain('not recorded from a live service')
    }
  })

  it.effect('decode, pass the shared secret scan, and stay synthetic', () =>
    Effect.gen(function* () {
      for (const fixture of figmaMcpConformanceFixtures) {
        expect((yield* decodeWireFixture(fixture)).id).toBe(fixture.id)
        expect(scanFixtureForSecrets(fixture), fixture.id).toEqual([])
        expect(fixture).toMatchObject({
          evidence: 'unverified',
          account: 'synthetic',
          endpoint: figmaMcpServerUrl
        })

        for (const { request, response } of fixture.exchanges) {
          expect(request.url).toBe(figmaMcpServerUrl)
          expect(
            Object.keys(request.headers ?? {}).every(
              name => mcpObservedRequestHeaders.includes(name) || name === 'mcp-session-id'
            )
          ).toBe(true)

          // Canonical JSON: the emulator substitutes ids in these bytes.
          if (isWireStreamResponse(response)) {
            for (const chunk of response.chunks) {
              if (!Predicate.isString(chunk)) return expect.fail('a binary chunk')

              for (const line of chunk.split('\n').filter(text => text.startsWith('data'))) {
                const payload = line.slice(dataPrefix.length)

                expect(JSON.stringify(decodeJsonText(payload))).toBe(payload)
              }
            }
          } else if (Predicate.hasProperty(response, 'body') && response.body !== '') {
            expect(JSON.stringify(decodeJsonText(String(response.body)))).toBe(response.body)
          }
        }
      }

      const serialized = JSON.stringify(figmaMcpConformanceFixtures)

      expect(serialized).not.toMatch(/"authorization"/i)
      expect(serialized).not.toContain(figmaMcpConformanceInvalidCredential)
      expect(serialized).not.toContain(syntheticToken)
    })
  )

  it('the era probe carries the client envelope and the probe id of the pinned SDK', () => {
    expect(figmaMcpConformanceProbeEnvelope).toEqual(mcpConformanceSyntheticEnvelope)

    const probe = figmaMcpConformanceFixtures[0]?.exchanges[0]?.request.body

    expect(isRecord(probe) ? probe['id'] : undefined).toBe(mcpConformanceDiscoverRequestId)
  })

  it('the listing publishes the known tool names with synthetic schemas', () => {
    const names = figmaMcpConformanceTools.map(tool => tool['name'])

    expect(names).toEqual(figmaMcpConformanceExpectedTools)
    expect(figmaMcpConformanceLiveSeeds).toEqual({
      expectedTools: figmaMcpConformanceExpectedTools,
      notReadOnly: figmaMcpConformanceNotReadOnly
    })

    const readOnly = (name: string) => {
      const tool = figmaMcpConformanceTools.find(candidate => candidate['name'] === name)
      const annotations = tool?.['annotations']

      return isRecord(annotations) ? annotations['readOnlyHint'] : undefined
    }

    expect(figmaMcpConformanceNotReadOnly.map(readOnly)).toEqual([false, false])
    expect(readOnly(figmaMcpConformanceReadCall.name)).toBe(true)

    for (const tool of figmaMcpConformanceTools) {
      expect(tool['description']).toBe('Synthetic placeholder description.')
    }

    for (const fixture of figmaMcpConformanceFixtures) {
      for (const exchange of fixture.exchanges.filter(entry => rpcMethod(entry) === 'tools/list')) {
        const [message] = messagesOf(exchange.response)
        const result = isRecord(message) ? message['result'] : undefined

        expect(isRecord(result) ? result['tools'] : undefined).toEqual(figmaMcpConformanceTools)
      }
    }
  })

  it('every tools/call answer is a minimal synthetic body (allowlist)', () => {
    const words = new Set([
      'Synthetic metadata of node 0:1.',
      'Invalid arguments: nodeId must be a string.',
      'Tool yolk_conformance_absent not found',
      'text',
      '2.0'
    ])

    const keys = new Set(['jsonrpc', 'id', 'result', 'error', 'code', 'message', 'content'])

    const allowedKeys = new Set([...keys, 'type', 'text', 'isError'])

    const refusals = (value: Schema.Json): ReadonlyArray<string> => {
      if (Predicate.isString(value)) return words.has(value) ? [] : [value]

      if (Array.isArray(value)) return value.flatMap(refusals)

      return isRecord(value)
        ? Object.entries(value).flatMap(([key, item]) => [
            ...(allowedKeys.has(key) ? [] : [`key ${key}`]),
            ...refusals(item)
          ])
        : []
    }

    for (const fixture of figmaMcpConformanceFixtures) {
      for (const exchange of fixture.exchanges.filter(entry => rpcMethod(entry) === 'tools/call')) {
        expect(messagesOf(exchange.response).flatMap(refusals), fixture.id).toEqual([])
      }
    }
  })
})

describe('Figma MCP cases on replay', () => {
  it.effect('every applicable case passes with unverified warnings', () =>
    Effect.gen(function* () {
      const report = yield* runConformance(applicable, {
        target: { kind: 'replay' },
        now,
        fixtures: figmaMcpConformanceFixtures,
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
      expect(JSON.stringify(report)).not.toContain(syntheticToken)
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
          replayLayer([fixtureOf(testCase)], { seeds: figmaMcpConformanceLiveSeeds })
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
    // The probe answered with a modern discover result: the client leaves the legacy era.
    id: 'mcp.negotiation.era',
    change: answerOf('server/discover', response => ({
      status: 200,
      headers: response.headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: mcpConformanceDiscoverRequestId,
        result: {
          supportedVersions: ['2026-07-28'],
          capabilities: { tools: {} },
          resultType: 'complete',
          ttlMs: 0,
          cacheScope: 'private'
        }
      })
    })),
    message: 'expected the era probe answer to select the legacy era'
  },
  {
    id: 'mcp.legacy.session',
    change: answerOf('notifications/initialized', () => ({ status: 200, headers: {}, body: '' })),
    message: 'expected notifications/initialized to get 202 with an empty body'
  },
  {
    id: 'mcp.transport.response-encoding',
    change: answerOf('tools/list', response => ({
      ...response,
      headers: { ...response.headers, 'content-type': 'text/plain' }
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
          tools: (Array.isArray(tools) ? tools : []).map(tool =>
            isRecord(tool) && tool['name'] === 'use_figma'
              ? { ...tool, annotations: { readOnlyHint: true } }
              : tool
          )
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
    change: answerOf(
      'tools/call',
      mapSseMessage(message => ({
        jsonrpc: '2.0',
        id: message['id'] ?? null,
        error: { code: -32_602, message: 'Synthetic drill error.' }
      }))
    ),
    message:
      'expected invalid arguments to answer a tool result with isError: true, not a JSON-RPC error'
  },
  {
    id: 'mcp.errors.unknown-tool',
    change: answerOf(
      'tools/call',
      mapSseMessage(message => ({
        jsonrpc: '2.0',
        id: message['id'] ?? null,
        result: { content: [{ type: 'text', text: 'Synthetic drill.' }] }
      }))
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
