/**
 * MCP emulator unit tests: the manifest, the fixture data copy, the drift test (every fixture
 * replayed and each complete response compared byte for byte, substituting only the request id
 * and the minted session id at their exact places), the documented request-shape latitude, every
 * refusal as a constant-text 400 that changes no state and uses up no match-all fault (which
 * still answers the next valid request), the bearer and the reserved invalid credential never
 * ledgered, stored, or echoed, credential repeats, the legacy session lifecycle, cursor issuance,
 * faults, seeds, and the control plane. Tests may import SDK packages; the emulator source never
 * does.
 */
import { readFileSync } from 'node:fs'
import { Predicate } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import type * as Schema from 'effect/Schema'
import {
  mcpConformanceCases,
  mcpConformanceFixtures,
  mcpConformanceInvalidCredential,
  mcpConformanceSyntheticLegacyUrl,
  mcpConformanceSyntheticModernUrl,
  mcpConformanceSyntheticOrigin,
  mcpConformanceSyntheticSessionId
} from '@yolk-sdk/mcp/conformance'
import { afloatMcpServerUrl } from '@yolk-sdk/connectors/afloat'
import {
  afloatMcpConformanceFixtures,
  afloatMcpConformanceInvalidCredential
} from '@yolk-sdk/connectors/afloat/conformance'
import {
  McpEmulatorInputInvalid,
  emulatorEvidenceHeader,
  isMcpEmulatedRequestId,
  makeMcpEmulator,
  mcpEmulatorAfloatFixtures,
  mcpEmulatorAfloatKeyPrefix,
  mcpEmulatorAfloatOrigin,
  mcpEmulatorAfloatPath,
  mcpEmulatorAfloatReservedInvalidCredential,
  mcpEmulatorFixtures,
  mcpEmulatorOrigin,
  mcpEmulatorReservedInvalidCredential,
  mcpEmulatorRoutes,
  mcpEmulatorSessionCap,
  type McpEmulator,
  type McpEmulatorOptions,
  type McpRecordedExchange,
  type McpRecordedFixture
} from '../src/mcp.ts'
import { mcpRecordingProblems } from '../src/mcp/api.ts'
import { isJsonObject } from '../src/stateful-emulator.ts'
import { isRecognisableBearerValue } from '../src/stateful-secrets.ts'

const modernUrl = `${mcpEmulatorOrigin}/modern/mcp`

const legacyUrl = `${mcpEmulatorOrigin}/legacy/mcp`

const afloatUrl = `${mcpEmulatorAfloatOrigin}${mcpEmulatorAfloatPath}`

/** A synthetic Afloat key the emulator accepts: `afloat_` and a recognisable remainder. */
const afloatToken = 'afloat_synthetic-mcp-unit-key-0001'

const afloatReserved = mcpEmulatorAfloatReservedInvalidCredential

/** A synthetic bearer the emulator accepts (never account data). */
const token = 'synthetic-mcp-unit-token-0001'

const reserved = mcpEmulatorReservedInvalidCredential

const row = (url: string, method: string) => `${url}#${method}`

const fixtureById = (id: string): McpRecordedFixture => {
  const fixture = [...mcpEmulatorFixtures, ...mcpEmulatorAfloatFixtures].find(
    candidate => candidate.id === id
  )

  if (fixture === undefined) throw new Error(`no fixture ${id}`)

  return fixture
}

const exchangeOf = (id: string, index: number): McpRecordedExchange => {
  const exchange = fixtureById(id).exchanges.at(index)

  if (exchange === undefined) throw new Error(`no exchange ${index} of ${id}`)

  return exchange
}

const modernEra = 'mcp.negotiation.era.modern.synthetic'

const legacyEra = 'mcp.negotiation.era.legacy.synthetic'

/** The recorded requests the tests vary. */
const recorded = {
  modernDiscover: exchangeOf(modernEra, 0),
  modernList: exchangeOf(modernEra, 1),
  modernSecondPage: exchangeOf('mcp.tools.list.modern.synthetic', 2),
  modernCallRead: exchangeOf('mcp.tools.call-read.modern.synthetic', -1),
  legacyDiscover: exchangeOf(legacyEra, 0),
  legacyInitialize: exchangeOf(legacyEra, 1),
  legacyInitialized: exchangeOf(legacyEra, 2),
  legacyGet: exchangeOf(legacyEra, 3),
  legacyList: exchangeOf(legacyEra, 4),
  legacyCallRead: exchangeOf('mcp.tools.call-read.legacy.synthetic', -1),
  afloatDiscover: exchangeOf('mcp.negotiation.era.afloat.synthetic', 0),
  afloatList: exchangeOf('mcp.negotiation.era.afloat.synthetic', 1),
  afloatCallRead: exchangeOf('mcp.tools.call-read.afloat.synthetic', -1)
}

type Send = {
  readonly method?: string
  readonly url?: string
  readonly headers?: Readonly<Record<string, string | undefined>>
  readonly body?: Schema.Json | string
  /** The bearer (default `token`); `null` sends no Authorization header. */
  readonly bearer?: string | null
}

/** A request shaped like `exchange`'s recorded one, with `send` overrides. */
const requestFor = (exchange: McpRecordedExchange, send: Send = {}): Request => {
  const bearer = send.bearer === undefined ? token : send.bearer
  const merged: Record<string, string> = {}

  for (const [name, value] of Object.entries({ ...exchange.request.headers, ...send.headers })) {
    if (value !== undefined) merged[name] = value
  }

  if (bearer !== null) merged['authorization'] = `Bearer ${bearer}`

  const body = 'body' in send ? send.body : exchange.request.body

  return new Request(send.url ?? exchange.request.url, {
    method: send.method ?? exchange.request.method,
    headers: merged,
    body: body === undefined ? undefined : Predicate.isString(body) ? body : JSON.stringify(body)
  })
}

/** The recorded body with `change` applied (an `undefined` value removes the member). */
const bodyWith = (
  exchange: McpRecordedExchange,
  change: Readonly<Record<string, Schema.Json | undefined>>
): Schema.JsonObject => {
  const body = exchange.request.body
  const merged: Record<string, Schema.Json> = {}

  if (isJsonObject(body)) Object.assign(merged, body)

  for (const [key, value] of Object.entries(change)) {
    if (value === undefined) {
      delete merged[key]
    } else {
      merged[key] = value
    }
  }

  return merged
}

/** The recorded body with `change` applied to its params. */
const paramsWith = (
  exchange: McpRecordedExchange,
  change: Readonly<Record<string, Schema.Json>>
): Schema.JsonObject => {
  const params = bodyWith(exchange, {})['params']
  const merged: Record<string, Schema.Json> = {}

  if (isJsonObject(params)) Object.assign(merged, params)

  Object.assign(merged, change)

  return bodyWith(exchange, { params: merged })
}

const recordedText = (exchange: McpRecordedExchange): string =>
  'chunks' in exchange.response ? exchange.response.chunks.join('') : exchange.response.body

const withEmulator = async <A>(
  options: McpEmulatorOptions,
  run: (emulator: McpEmulator) => Promise<A>
): Promise<A> => {
  const emulator = await makeMcpEmulator(options)

  try {
    return await run(emulator)
  } finally {
    await emulator.close()
  }
}

/** The legacy handshake on `emulator`: answers the minted session id (ready unless `phase`). */
const handshake = async (
  emulator: McpEmulator,
  phase: 'initializing' | 'ready' = 'ready'
): Promise<string> => {
  const initialized = await emulator.fetch(requestFor(recorded.legacyInitialize))
  const session = initialized.headers.get('mcp-session-id')

  await initialized.text()

  if (session === null) throw new Error('no session minted')

  if (phase === 'ready') {
    const ready = await emulator.fetch(
      requestFor(recorded.legacyInitialized, { headers: { 'mcp-session-id': session } })
    )

    expect(ready.status).toBe(202)
  }

  return session
}

const onSession = (exchange: McpRecordedExchange, session: string, send: Send = {}) =>
  requestFor(exchange, { ...send, headers: { 'mcp-session-id': session, ...send.headers } })

const responseHeaders = (response: Response) => {
  const headers: Record<string, string> = {}

  response.headers.forEach((value, name) => {
    if (name !== emulatorEvidenceHeader) headers[name] = value
  })

  return headers
}

/** Every request text a control-plane read and the real responses could leak. */
const controlPlaneText = async (emulator: McpEmulator) => {
  const reads = await Promise.all(
    ['ledger', 'state', 'coverage', 'faults'].map(route =>
      emulator
        .fetch(new Request(`${mcpEmulatorOrigin}/_emulate/${route}`))
        .then(response => response.text())
    )
  )

  return [
    JSON.stringify(emulator.ledger.entries()),
    JSON.stringify(emulator.snapshot()),
    ...reads
  ].join('\n')
}

describe('manifest', () => {
  it('one RPC row per recorded method of each profile, plus the GET row; no writes', () => {
    expect(mcpEmulatorRoutes.map(route => `${route.method} ${route.path}`)).toEqual([
      `RPC ${row(modernUrl, 'server/discover')}`,
      `RPC ${row(modernUrl, 'tools/list')}`,
      `RPC ${row(modernUrl, 'tools/call')}`,
      `RPC ${row(legacyUrl, 'server/discover')}`,
      `RPC ${row(legacyUrl, 'initialize')}`,
      `RPC ${row(legacyUrl, 'notifications/initialized')}`,
      `RPC ${row(legacyUrl, 'tools/list')}`,
      `RPC ${row(legacyUrl, 'tools/call')}`,
      `GET ${legacyUrl}`,
      `RPC ${row(afloatUrl, 'server/discover')}`,
      `RPC ${row(afloatUrl, 'tools/list')}`,
      `RPC ${row(afloatUrl, 'tools/call')}`
    ])

    for (const route of mcpEmulatorRoutes) {
      expect(route).toMatchObject({ kind: 'connector', write: false, evidence: 'unverified' })
      expect(route.observedAt).toBeUndefined()
    }

    const ids = mcpConformanceCases.map(testCase => testCase.id)

    const caseIdsOf = (path: string) =>
      mcpEmulatorRoutes.find(route => route.path === path)?.caseIds ?? []

    const listingCases = ids.filter(
      id => id !== 'mcp.auth.rejected' && id !== 'mcp.modern.stateless'
    )

    expect(caseIdsOf(row(modernUrl, 'server/discover'))).toEqual(
      ids.filter(id => id !== 'mcp.legacy.session')
    )
    expect(caseIdsOf(row(modernUrl, 'tools/call'))).toEqual([
      'mcp.modern.stateless',
      'mcp.tools.call-read',
      'mcp.tools.call-tool-error',
      'mcp.errors.unknown-tool'
    ])
    expect(caseIdsOf(row(legacyUrl, 'server/discover'))).toEqual(
      ids.filter(id => id !== 'mcp.modern.stateless')
    )
    expect(caseIdsOf(`${legacyUrl}`)).toEqual(listingCases)
    expect(caseIdsOf(row(legacyUrl, 'tools/call'))).toEqual([
      'mcp.tools.call-read',
      'mcp.tools.call-tool-error',
      'mcp.errors.unknown-tool'
    ])
    expect(caseIdsOf(row(afloatUrl, 'server/discover'))).toEqual(
      ids.filter(id => id !== 'mcp.legacy.session')
    )
    expect(caseIdsOf(row(afloatUrl, 'tools/list'))).toEqual(
      ids.filter(id => id !== 'mcp.legacy.session' && id !== 'mcp.auth.rejected')
    )
    expect(caseIdsOf(row(afloatUrl, 'tools/call'))).toEqual([
      'mcp.modern.stateless',
      'mcp.tools.call-read',
      'mcp.tools.call-tool-error',
      'mcp.errors.unknown-tool'
    ])
  })

  it('coverage counts each row; the control plane serves the same', async () => {
    await withEmulator({}, async emulator => {
      await (await emulator.fetch(requestFor(recorded.modernDiscover))).text()
      await (await emulator.fetch(requestFor(recorded.modernList))).text()

      const counts = emulator.coverage().routes.map(route => route.requests)

      expect(counts).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])

      const served = await emulator
        .fetch(new Request(`${mcpEmulatorOrigin}/_emulate/coverage`))
        .then(response => response.json())

      expect(served).toEqual(JSON.parse(JSON.stringify(emulator.coverage())))
    })
  })
})

describe('the data copy', () => {
  it('equals the @yolk-sdk/mcp/conformance fixtures, and the constants agree', () => {
    expect(mcpEmulatorFixtures).toEqual(mcpConformanceFixtures)
    expect(mcpEmulatorOrigin).toBe(mcpConformanceSyntheticOrigin)
    expect(modernUrl).toBe(mcpConformanceSyntheticModernUrl)
    expect(legacyUrl).toBe(mcpConformanceSyntheticLegacyUrl)
    expect(mcpEmulatorReservedInvalidCredential).toBe(mcpConformanceInvalidCredential)
  })

  it('the Afloat copy equals @yolk-sdk/connectors/afloat/conformance, and the constants agree', () => {
    expect(mcpEmulatorAfloatFixtures).toEqual(afloatMcpConformanceFixtures)
    expect(afloatUrl).toBe(afloatMcpServerUrl)
    expect(mcpEmulatorAfloatReservedInvalidCredential).toBe(afloatMcpConformanceInvalidCredential)
    expect(mcpRecordingProblems(mcpEmulatorAfloatFixtures)).toEqual([])
  })

  it('every recorded answer is canonical JSON; a non-canonical copy fails loudly', () => {
    expect(mcpRecordingProblems(mcpEmulatorFixtures)).toEqual([])

    const [first] = mcpEmulatorFixtures

    if (first === undefined) throw new Error('no fixtures')

    const [exchange] = first.exchanges

    if (exchange === undefined || 'chunks' in exchange.response) throw new Error('no JSON answer')

    const respaced = {
      ...first,
      exchanges: [
        {
          ...exchange,
          response: { ...exchange.response, body: exchange.response.body.replace(':', ': ') }
        },
        ...mcpEmulatorFixtures.flatMap(fixture =>
          fixture.id === legacyEra
            ? fixture.exchanges.flatMap(candidate =>
                'chunks' in candidate.response
                  ? [
                      {
                        ...candidate,
                        response: {
                          ...candidate.response,
                          chunks: candidate.response.chunks.map(chunk =>
                            chunk.replace('data: ', 'data:')
                          )
                        }
                      }
                    ]
                  : []
              )
            : []
        )
      ]
    }

    expect(mcpRecordingProblems([respaced])).toEqual([
      `${first.id} exchange 0: the JSON body is not canonical`,
      `${first.id} exchange 1 chunk 0: an SSE data line is not canonical`,
      `${first.id} exchange 1 chunk 1: an SSE data line is not canonical`,
      `${first.id} exchange 2 chunk 0: an SSE data line is not canonical`,
      `${first.id} exchange 2 chunk 1: an SSE data line is not canonical`
    ])
  })

  it('the reserved invalid credential is a recognisable bearer (handled explicitly)', () => {
    expect(isRecognisableBearerValue(mcpEmulatorReservedInvalidCredential)).toBe(true)
    expect(isRecognisableBearerValue(token)).toBe(true)
  })

  it('an Afloat key fails the plain rule; its remainder after afloat_ is the recognisable part', () => {
    const remainder = (key: string) => key.slice(mcpEmulatorAfloatKeyPrefix.length)

    for (const key of [afloatReserved, afloatToken]) {
      expect(key.startsWith(mcpEmulatorAfloatKeyPrefix)).toBe(true)
      expect(isRecognisableBearerValue(key)).toBe(false)
      expect(isRecognisableBearerValue(remainder(key))).toBe(true)
    }
  })
})

/** The recorded bearer of a fixture's requests: the reserved credential for the auth case. */
const bearerOf = (fixture: McpRecordedFixture) => {
  const afloat = fixture.endpoint === afloatUrl

  if (fixture.caseId === 'mcp.auth.rejected') return afloat ? afloatReserved : reserved

  return afloat ? afloatToken : token
}

/** Seed a fixture's replay needs (the paged listing only for `mcp.tools.list` modern). */
const seedOf = (fixture: McpRecordedFixture): McpEmulatorOptions =>
  fixture.id === 'mcp.tools.list.modern.synthetic' ? { seed: { modernListing: 'two-pages' } } : {}

/** What a replay sends for one recorded exchange. */
type ReplaySend = {
  bearer: string
  headers: Record<string, string>
  body?: Schema.Json
}

/**
 * Replay `fixture` on `emulator`, comparing each complete answer byte for byte. With `idFor`,
 * every recorded request id is replaced by `idFor(id)` and the expected answer has exactly its
 * top-level (JSON) or response-event (SSE) id replaced; the minted session id replaces the
 * recorded one in the requests and the recorded `mcp-session-id` answer header only.
 */
const replay = async (
  emulator: McpEmulator,
  fixture: McpRecordedFixture,
  idFor: (id: string | number) => string | number = id => id
) => {
  let session: string | undefined

  for (const [index, exchange] of fixture.exchanges.entries()) {
    const label = `${fixture.id} #${index}`
    const recordedBody = bodyWith(exchange, {})
    const recordedId = recordedBody['id']

    const id =
      Predicate.isString(recordedId) || Predicate.isNumber(recordedId) ? recordedId : undefined

    const headers: Record<string, string> = {}

    if (exchange.request.headers['mcp-session-id'] !== undefined && session !== undefined) {
      headers['mcp-session-id'] = session
    }

    const send: ReplaySend = { bearer: bearerOf(fixture), headers }

    if (exchange.request.body !== undefined && id !== undefined) {
      send.body = bodyWith(exchange, { id: idFor(id) })
    }

    const answer = await emulator.fetch(requestFor(exchange, send))

    const minted = answer.headers.get('mcp-session-id')

    if (minted !== null && exchange.request.headers['mcp-session-id'] === undefined) {
      expect(minted, label).toMatch(/^yolk-emu-session-\d+$/)
      session = minted
    }

    const expectedHeaders = { ...exchange.response.headers }

    if (expectedHeaders['mcp-session-id'] !== undefined) {
      expect(expectedHeaders['mcp-session-id'], label).toBe(mcpConformanceSyntheticSessionId)
      expectedHeaders['mcp-session-id'] = session ?? ''
    }

    let expectedText = recordedText(exchange)

    if (id !== undefined && idFor(id) !== id) {
      // The synthetic answers open with the id; the Afloat answers (the server SDK's member order
      // `result`, `jsonrpc`, `id`) close with it, except their errors, which open with it.
      const forms = [
        [
          `{"jsonrpc":"2.0","id":${JSON.stringify(id)},`,
          `{"jsonrpc":"2.0","id":${JSON.stringify(idFor(id))},`
        ],
        [
          `,"jsonrpc":"2.0","id":${JSON.stringify(id)}}`,
          `,"jsonrpc":"2.0","id":${JSON.stringify(idFor(id))}}`
        ]
      ] as const

      // Exactly one place carries the recorded request id (none on the id-null and 401 answers).
      const places = forms.reduce((count, [from]) => count + expectedText.split(from).length - 1, 0)

      expect(places, label).toBeLessThanOrEqual(1)

      for (const [from, to] of forms) expectedText = expectedText.replace(from, to)
    }

    expect(answer.status, label).toBe(exchange.response.status)
    expect(responseHeaders(answer), label).toEqual(expectedHeaders)
    expect(answer.headers.get(emulatorEvidenceHeader), label).toBe('unverified')
    expect(await answer.text(), label).toBe(expectedText)
  }
}

describe('drift: every fixture replayed byte for byte', () => {
  // The data copies, equal to `mcpConformanceFixtures` and `afloatMcpConformanceFixtures`.
  for (const fixture of [...mcpEmulatorFixtures, ...mcpEmulatorAfloatFixtures]) {
    it(`${fixture.id} alone`, async () => {
      await withEmulator(seedOf(fixture), async emulator => {
        await replay(emulator, fixture)
        expect(emulator.ledger.entries().every(entry => entry.notEmulated === undefined)).toBe(true)
      })
    })

    it(`${fixture.id} with other request ids, substituted at the recorded place only`, async () => {
      await withEmulator(seedOf(fixture), async emulator => {
        await replay(emulator, fixture, id =>
          Predicate.isNumber(id) ? id + 9_000_000_000_000 : `${id} (emu)`
        )
      })
    })
  }

  it('every one-page fixture in suite order on ONE emulator', async () => {
    await withEmulator({}, async emulator => {
      for (const fixture of [...mcpEmulatorFixtures, ...mcpEmulatorAfloatFixtures]) {
        if (seedOf(fixture).seed === undefined) await replay(emulator, fixture)
      }

      const sessions = emulator.snapshot().sessions.map(session => session.id)

      expect(sessions).toEqual(sessions.map((_, index) => `yolk-emu-session-${index + 1}`))
      expect(sessions.length).toBe(10)
    })
  })
})

describe('latitude', () => {
  it('any accepted id, JSON key order, and the _meta client info name and version', async () => {
    await withEmulator({}, async emulator => {
      for (const id of [0, 2 ** 53 - 1, 'x', ' ~'.repeat(32)]) {
        expect(isMcpEmulatedRequestId(id)).toBe(true)

        const answer = await emulator.fetch(
          requestFor(recorded.modernDiscover, { body: bodyWith(recorded.modernDiscover, { id }) })
        )

        expect(answer.status).toBe(200)
        expect((await answer.json()).id).toBe(id)
      }

      const reordered = JSON.stringify({
        params: {
          _meta: {
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { version: '9.9.9', name: 'synthetic-host' },
            'io.modelcontextprotocol/protocolVersion': '2026-07-28'
          }
        },
        method: 'server/discover',
        id: 'synthetic-probe',
        jsonrpc: '2.0'
      })

      const answer = await emulator.fetch(requestFor(recorded.modernDiscover, { body: reordered }))

      expect(answer.status).toBe(200)
      expect(await answer.text()).toBe(
        recordedText(recorded.modernDiscover).replace(
          '"id":"server-discover-probe-1"',
          '"id":"synthetic-probe"'
        )
      )
    })
  })
})

describe('the request-shape latitude bullet', () => {
  const bulletIn = (relative: string) => {
    const text = readFileSync(new URL(relative, import.meta.url), 'utf8')
    const start = text.indexOf('Request-shape latitude (`/mcp`')
    const end = text.indexOf('is not emulated.', start)

    expect(start, relative).toBeGreaterThan(-1)

    return text
      .slice(start, end)
      .replace(/^\s*\*\s?/gm, '')
      .replace(/\*\*/g, '')
      .replace(/\s+/g, ' ')
      .replace('deviations). Any', 'deviations): any')
      .trim()
  }

  it('has four copies that agree word for word', () => {
    const copies = [
      '../src/mcp.ts',
      '../AGENTS.md',
      '../README.md',
      '../../../apps/docs/content/docs/api-reference/emulators.mdx'
    ].map(bulletIn)

    expect(new Set(copies).size, copies.join('\n\n')).toBe(1)
  })
})

type Refusal = {
  readonly name: string
  readonly options?: McpEmulatorOptions
  /** Earlier requests (a handshake, for example); answers the request to refuse. */
  readonly request: (emulator: McpEmulator) => Promise<Request> | Request
  readonly reason: string
}

const noRoute = 'no emulated MCP route for this method and path'

const refusals: ReadonlyArray<Refusal> = [
  {
    name: 'DELETE (the client never sends it)',
    request: () => requestFor(recorded.legacyGet, { method: 'DELETE' }),
    reason: noRoute
  },
  {
    name: 'a GET on the modern profile',
    request: () => requestFor(recorded.legacyGet, { url: modernUrl }),
    reason: noRoute
  },
  {
    name: 'another path',
    request: () => requestFor(recorded.modernDiscover, { url: `${mcpEmulatorOrigin}/other/mcp` }),
    reason: noRoute
  },
  {
    name: 'the Afloat path on the synthetic origin',
    request: () => requestFor(recorded.afloatDiscover, { url: `${mcpEmulatorOrigin}/mcp` }),
    reason: 'this route is recorded on https://useafloat.com only'
  },
  {
    name: 'a synthetic path on the Afloat origin',
    request: () =>
      requestFor(recorded.modernDiscover, {
        url: `${mcpEmulatorAfloatOrigin}/modern/mcp`,
        bearer: afloatToken
      }),
    reason: 'this route is recorded on https://mcp.example.test only'
  },
  {
    name: 'a bearer without afloat_ on the Afloat profile',
    request: () => requestFor(recorded.afloatDiscover, { bearer: token }),
    reason: 'an unrecognisable Authorization header is not emulated'
  },
  {
    name: 'an Afloat key whose remainder starts with a hex digit (a real key shape)',
    request: () =>
      requestFor(recorded.afloatDiscover, { bearer: `afloat_${'0123456789abcdef'.repeat(4)}` }),
    reason: 'an unrecognisable Authorization header is not emulated'
  },
  {
    name: 'an Afloat key on the synthetic profiles',
    request: () => requestFor(recorded.modernDiscover, { bearer: afloatToken }),
    reason: 'an unrecognisable Authorization header is not emulated'
  },
  {
    name: 'a GET on the Afloat profile',
    request: () =>
      requestFor(recorded.afloatDiscover, { method: 'GET', body: undefined, bearer: afloatToken }),
    reason: noRoute
  },
  {
    name: 'a cursor on the Afloat listing',
    request: () =>
      requestFor(recorded.afloatList, {
        bearer: afloatToken,
        body: paramsWith(recorded.afloatList, { cursor: 'synthetic-cursor-0001' })
      }),
    reason: 'params other than the recorded ones are not emulated'
  },
  {
    name: 'prompts/list on the Afloat profile',
    request: () =>
      requestFor(recorded.afloatList, {
        bearer: afloatToken,
        headers: { 'mcp-method': 'prompts/list' },
        body: bodyWith(recorded.afloatList, { method: 'prompts/list' })
      }),
    reason: 'this JSON-RPC method is not emulated on the Afloat profile'
  },
  {
    name: 'another Afloat tool',
    request: () =>
      requestFor(recorded.afloatCallRead, {
        bearer: afloatToken,
        headers: { 'mcp-name': 'get-invoice-pdf' },
        body: paramsWith(recorded.afloatCallRead, {
          name: 'get-invoice-pdf',
          arguments: { invoiceId: 'yolksyntheticinvoice0001' }
        })
      }),
    reason: 'params other than the recorded ones are not emulated'
  },
  {
    name: 'other Afloat arguments',
    request: () =>
      requestFor(recorded.afloatCallRead, {
        bearer: afloatToken,
        body: paramsWith(recorded.afloatCallRead, { arguments: { size: 25 } })
      }),
    reason: 'params other than the recorded ones are not emulated'
  },
  {
    name: 'the reserved invalid Afloat credential on tools/list',
    request: () => requestFor(recorded.afloatList, { bearer: afloatReserved }),
    reason: 'the reserved invalid credential is answered only on the era probe'
  },
  {
    name: 'mcp-session-id on an Afloat request',
    request: () =>
      requestFor(recorded.afloatDiscover, {
        bearer: afloatToken,
        headers: { 'mcp-session-id': 'yolk-emu-session-1' }
      }),
    reason: 'mcp-session-id must be sent exactly where the recording sends one'
  },
  {
    name: 'another origin',
    request: () =>
      requestFor(recorded.modernDiscover, { url: 'https://other.example.test/modern/mcp' }),
    reason: 'this route is recorded on https://mcp.example.test only'
  },
  {
    name: 'a query parameter',
    request: () => requestFor(recorded.modernDiscover, { url: `${modernUrl}?x=1` }),
    reason: 'query parameters are not emulated'
  },
  {
    name: 'no Authorization header',
    request: () => requestFor(recorded.modernDiscover, { bearer: null }),
    reason:
      'requests without Authorization: Bearer <token of at least 8 characters> are not emulated'
  },
  {
    name: 'an unrecognisable Authorization header',
    request: () =>
      requestFor(recorded.modernDiscover, {
        bearer: null,
        headers: { authorization: `Basic ${token}` }
      }),
    reason: 'an unrecognisable Authorization header is not emulated'
  },
  {
    name: 'ping',
    request: () =>
      requestFor(recorded.modernDiscover, {
        headers: { 'mcp-method': 'ping' },
        body: bodyWith(recorded.modernDiscover, { method: 'ping' })
      }),
    reason: 'this JSON-RPC method is not emulated on the modern profile'
  },
  {
    name: 'resources/list (legacy)',
    request: async emulator => {
      const session = await handshake(emulator)

      return onSession(recorded.legacyList, session, {
        body: bodyWith(recorded.legacyList, { method: 'resources/list' })
      })
    },
    reason: 'this JSON-RPC method is not emulated on the legacy profile'
  },
  {
    name: 'prompts/list (modern)',
    request: () =>
      requestFor(recorded.modernList, {
        headers: { 'mcp-method': 'prompts/list' },
        body: bodyWith(recorded.modernList, { method: 'prompts/list' })
      }),
    reason: 'this JSON-RPC method is not emulated on the modern profile'
  },
  {
    name: 'a JSON-RPC batch',
    request: () =>
      requestFor(recorded.modernDiscover, { body: [bodyWith(recorded.modernDiscover, {})] }),
    reason: 'this JSON-RPC method is not emulated on the modern profile'
  },
  {
    name: 'a client-sent response',
    request: () =>
      requestFor(recorded.modernDiscover, { body: { jsonrpc: '2.0', id: 1, result: {} } }),
    reason: 'this JSON-RPC method is not emulated on the modern profile'
  },
  ...[null, 1.5, -1, 'x'.repeat(65), '', 'tab\there'].map((id): Refusal => ({
    name: `the request id ${JSON.stringify(id)}`,
    request: () =>
      requestFor(recorded.modernDiscover, { body: bodyWith(recorded.modernDiscover, { id }) }),
    reason:
      'the request id must be an integer from 0 to 2^53 - 1 or 1 to 64 printable ASCII characters'
  })),
  {
    name: 'an extra member',
    request: () =>
      requestFor(recorded.modernDiscover, {
        body: bodyWith(recorded.modernDiscover, { extra: true })
      }),
    reason: 'the JSON-RPC message must have exactly the recorded members'
  },
  {
    name: 'jsonrpc other than 2.0',
    request: () =>
      requestFor(recorded.modernDiscover, {
        body: bodyWith(recorded.modernDiscover, { jsonrpc: '1.0' })
      }),
    reason: 'jsonrpc must be "2.0"'
  },
  ...(
    [
      ['mcp-method', 'tools/list'],
      ['mcp-protocol-version', '2025-11-25'],
      ['accept', 'application/json'],
      ['content-type', 'application/json; charset=utf-8'],
      ['last-event-id', 'evt-1']
    ] as const
  ).map(([name, value]): Refusal => ({
    name: `the ${name} header ${value}`,
    request: () => requestFor(recorded.modernDiscover, { headers: { [name]: value } }),
    reason: `the ${name} header must be the recorded value, or absent where none is`
  })),
  {
    name: 'a missing mcp-method header',
    request: () => requestFor(recorded.modernDiscover, { headers: { 'mcp-method': undefined } }),
    reason: 'the mcp-method header must be the recorded value, or absent where none is'
  },
  {
    name: 'an mcp-param-* header no recording carries',
    request: () =>
      requestFor(recorded.modernCallRead, { headers: { 'mcp-param-note-id': 'note-0001' } }),
    reason: 'an mcp-* header no recording carries is not emulated'
  },
  {
    name: 'another mcp-* header on the standing GET',
    request: async emulator =>
      onSession(recorded.legacyGet, await handshake(emulator), {
        headers: { 'mcp-extra': '1' }
      }),
    reason: 'an mcp-* header no recording carries is not emulated'
  },
  ...[
    `{"jsonrpc":"2.0","id":1,"id":2,"method":"tools/list","params":${JSON.stringify(bodyWith(recorded.modernList, {})['params'])}}`,
    `{"jsonrpc":"2.0","\\u0069d":1,"id":2,"method":"tools/list","params":${JSON.stringify(bodyWith(recorded.modernList, {})['params'])}}`
  ].map((body, index): Refusal => ({
    name: `a JSON body repeating a key (${index === 0 ? 'raw' : 'escaped'})`,
    request: () => requestFor(recorded.modernList, { body }),
    reason: 'a JSON body with a repeated key is not emulated'
  })),
  {
    name: 'mcp-session-id on a modern request',
    request: () =>
      requestFor(recorded.modernDiscover, { headers: { 'mcp-session-id': 'yolk-emu-session-1' } }),
    reason: 'mcp-session-id must be sent exactly where the recording sends one'
  },
  {
    name: 'a _meta client info with another key',
    request: () =>
      requestFor(recorded.modernDiscover, {
        body: paramsWith(recorded.modernDiscover, {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'a', version: '1', title: 't' },
            'io.modelcontextprotocol/clientCapabilities': {}
          }
        })
      }),
    reason: 'the _meta client info must be a non-empty name and version only'
  },
  {
    name: 'a _meta client info with an empty name',
    request: () =>
      requestFor(recorded.modernDiscover, {
        body: paramsWith(recorded.modernDiscover, {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: '', version: '1' },
            'io.modelcontextprotocol/clientCapabilities': {}
          }
        })
      }),
    reason: 'the _meta client info must be a non-empty name and version only'
  },
  {
    name: 'other client capabilities',
    request: () =>
      requestFor(recorded.modernDiscover, {
        body: paramsWith(recorded.modernDiscover, {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'yolk', version: '0.1.0' },
            'io.modelcontextprotocol/clientCapabilities': { roots: {} }
          }
        })
      }),
    reason: 'params other than the recorded ones are not emulated'
  },
  {
    name: 'a cursor on the one-page listing',
    request: () => requestFor(recorded.modernSecondPage),
    reason: 'a cursor this emulator did not issue since the last reset or seed is not emulated'
  },
  {
    name: 'the recorded cursor before the first page issued it',
    options: { seed: { modernListing: 'two-pages' } },
    request: () => requestFor(recorded.modernSecondPage),
    reason: 'a cursor this emulator did not issue since the last reset or seed is not emulated'
  },
  {
    name: 'another tool',
    request: () =>
      requestFor(recorded.modernCallRead, {
        headers: { 'mcp-name': 'create_synthetic_note' },
        body: paramsWith(recorded.modernCallRead, {
          name: 'create_synthetic_note',
          arguments: { text: 'x' }
        })
      }),
    reason: 'params other than the recorded ones are not emulated'
  },
  {
    name: 'other arguments',
    request: () =>
      requestFor(recorded.modernCallRead, {
        body: paramsWith(recorded.modernCallRead, { arguments: { noteId: 'note-0002' } })
      }),
    reason: 'params other than the recorded ones are not emulated'
  },
  {
    name: 'an mcp-name other than the tool name',
    request: () =>
      requestFor(recorded.modernCallRead, { headers: { 'mcp-name': 'yolk_conformance_absent' } }),
    reason: 'params other than the recorded ones are not emulated'
  },
  {
    name: 'the reserved invalid credential on tools/list',
    request: () => requestFor(recorded.modernList, { bearer: reserved }),
    reason: 'the reserved invalid credential is answered only on the era probe'
  },
  {
    name: 'the reserved invalid credential on initialize',
    request: () => requestFor(recorded.legacyInitialize, { bearer: reserved }),
    reason: 'the reserved invalid credential is answered only on the era probe'
  },
  {
    name: 'initialize with another protocolVersion',
    request: () =>
      requestFor(recorded.legacyInitialize, {
        body: paramsWith(recorded.legacyInitialize, { protocolVersion: '2025-06-18' })
      }),
    reason: 'params other than the recorded ones are not emulated'
  },
  {
    name: 'initialize with another client info (legacy)',
    request: () =>
      requestFor(recorded.legacyInitialize, {
        body: paramsWith(recorded.legacyInitialize, {
          clientInfo: { name: 'synthetic-host', version: '1.0.0' }
        })
      }),
    reason: 'params other than the recorded ones are not emulated'
  },
  {
    name: 'initialize with an mcp-protocol-version header',
    request: () =>
      requestFor(recorded.legacyInitialize, { headers: { 'mcp-protocol-version': '2025-11-25' } }),
    reason: 'the mcp-protocol-version header must be the recorded value, or absent where none is'
  },
  {
    name: 'tools/list without a session header',
    request: () => requestFor(recorded.legacyList, { headers: { 'mcp-session-id': undefined } }),
    reason: 'mcp-session-id must be sent exactly where the recording sends one'
  },
  {
    name: 'tools/list on a session this emulator never minted',
    request: () => onSession(recorded.legacyList, mcpConformanceSyntheticSessionId),
    reason: 'a request on no ready session of this emulator is not emulated'
  },
  {
    name: 'tools/list before notifications/initialized',
    request: async emulator =>
      onSession(recorded.legacyList, await handshake(emulator, 'initializing')),
    reason: 'a request on no ready session of this emulator is not emulated'
  },
  {
    name: 'a second notifications/initialized',
    request: async emulator => onSession(recorded.legacyInitialized, await handshake(emulator)),
    reason: 'notifications/initialized on no initializing session of this emulator is not emulated'
  },
  {
    name: 'a GET before notifications/initialized',
    request: async emulator =>
      onSession(recorded.legacyGet, await handshake(emulator, 'initializing')),
    reason: 'a request on no ready session of this emulator is not emulated'
  },
  {
    name: 'a GET with last-event-id (resumption)',
    request: async emulator =>
      onSession(recorded.legacyGet, await handshake(emulator), {
        headers: { 'last-event-id': 'evt-1' }
      }),
    reason: 'the last-event-id header must be the recorded value, or absent where none is'
  },
  {
    name: 'a GET with a body-less query',
    request: async emulator =>
      onSession(recorded.legacyGet, await handshake(emulator), { url: `${legacyUrl}?resume=1` }),
    reason: 'query parameters are not emulated'
  },
  {
    name: 'a tools/call on a session reset cleared',
    request: async emulator => {
      const session = await handshake(emulator)

      await emulator.reset()

      return onSession(recorded.legacyCallRead, session)
    },
    reason: 'a request on no ready session of this emulator is not emulated'
  }
]

/** A valid request answered after a refusal (the modern era probe). */
const valid = () => requestFor(recorded.modernDiscover)

describe('refusals: a constant-text 400 that writes nothing and uses up no fault', () => {
  for (const refusal of refusals) {
    it(refusal.name, async () => {
      await withEmulator(refusal.options ?? {}, async emulator => {
        const request = await refusal.request(emulator)
        const before = emulator.snapshot()
        const marker = emulator.ledger.entries().length

        emulator.faults.add({ kind: 'status', status: 503 })

        const answer = await emulator.fetch(request)
        const text = await answer.text()

        expect(answer.status).toBe(400)
        expect(JSON.parse(text)).toEqual({
          error: { type: 'not_emulated', message: `Not emulated: ${refusal.reason}` }
        })

        const entries = emulator.ledger.entries().slice(marker)

        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({
          path: '/<unrecognised>',
          query: {},
          headers: {},
          status: 400,
          notEmulated: refusal.reason
        })
        expect(entries[0]?.body).toBeUndefined()
        expect(entries[0]?.bodyBytes).toBeUndefined()
        expect(emulator.snapshot()).toEqual(before)
        expect(emulator.faults.list().map(fault => fault.applied)).toEqual([0])

        // The unused match-all fault still answers the next valid request.
        expect((await emulator.fetch(valid())).status).toBe(503)
        expect(emulator.faults.list().map(fault => fault.applied)).toEqual([1])
      })
    })
  }
})

describe('the credential guard', () => {
  it('answers the reserved invalid credential the recorded 401 on both profiles', async () => {
    await withEmulator({}, async emulator => {
      for (const id of [
        'mcp.auth.rejected.modern.synthetic',
        'mcp.auth.rejected.legacy.synthetic'
      ]) {
        const exchange = exchangeOf(id, 0)
        const answer = await emulator.fetch(requestFor(exchange, { bearer: reserved }))

        expect(answer.status).toBe(401)
        expect(responseHeaders(answer)).toEqual(exchange.response.headers)
        expect(await answer.text()).toBe(recordedText(exchange))
      }

      const text = await controlPlaneText(emulator)

      expect(text).not.toContain(reserved)
      expect(text).not.toContain(token)
      expect(text.toLowerCase()).not.toContain('bearer')
    })
  })

  const escaped = token.replace('s', '\\u0073')

  const repeats: ReadonlyArray<readonly [string, (session: string) => Request, string]> = [
    [
      'as the request id',
      () =>
        requestFor(recorded.modernDiscover, {
          body: bodyWith(recorded.modernDiscover, { id: token })
        }),
      'the request body repeats the credential'
    ],
    [
      'JSON-escaped in the client info',
      () =>
        requestFor(recorded.modernDiscover, {
          body: JSON.stringify(
            paramsWith(recorded.modernDiscover, {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': { name: 'ESCAPED', version: '1' },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            })
          ).replace('ESCAPED', escaped)
        }),
      'the request body repeats the credential'
    ],
    [
      'as a JSON key',
      () =>
        requestFor(recorded.modernDiscover, {
          body: JSON.stringify(bodyWith(recorded.modernDiscover, {})).replace(
            '"jsonrpc"',
            `"${escaped}":1,"jsonrpc"`
          )
        }),
      'the request body repeats the credential'
    ],
    [
      'percent-encoded in a query key',
      () =>
        requestFor(recorded.modernDiscover, {
          url: `${modernUrl}?${encodeURIComponent(token).replace('s', '%73')}=1`
        }),
      'the query repeats the credential'
    ],
    [
      'in the mcp-session-id header',
      session =>
        onSession(recorded.legacyList, session, {
          headers: { 'mcp-session-id': `${session}${token}` }
        }),
      'a recorded request header repeats the credential'
    ],
    [
      'in the mcp-name header',
      () => requestFor(recorded.modernCallRead, { headers: { 'mcp-name': token } }),
      'a recorded request header repeats the credential'
    ],
    [
      'in a header the ledger does not record',
      () => requestFor(recorded.modernDiscover, { headers: { 'x-trace': token } }),
      'a request header repeats the credential'
    ],
    [
      'percent-encoded in a header the ledger does not record',
      () =>
        requestFor(recorded.modernDiscover, {
          headers: { 'x-trace': `trace ${token.replace('s', '%73')}` }
        }),
      'a request header repeats the credential'
    ],
    [
      'JSON-escaped in a header the ledger does not record',
      () => requestFor(recorded.modernDiscover, { headers: { 'x-trace': escaped } }),
      'a request header repeats the credential'
    ],
    [
      'in a header name',
      () => requestFor(recorded.modernDiscover, { headers: { [`x-${token}`]: '1' } }),
      'a request header repeats the credential'
    ]
  ]

  for (const [name, request, reason] of repeats) {
    it(`refuses the bearer repeated ${name}: constant text, nothing kept or echoed`, async () => {
      await withEmulator({}, async emulator => {
        const session = await handshake(emulator)
        const before = emulator.snapshot()

        emulator.faults.add({ kind: 'status', status: 503 })

        const answer = await emulator.fetch(request(session))
        const text = await answer.text()

        expect(answer.status).toBe(400)
        expect(text).not.toContain(token)
        expect(emulator.ledger.entries().at(-1)).toMatchObject({
          path: '/<unrecognised>',
          query: {},
          headers: {},
          notEmulated: reason
        })
        expect(emulator.snapshot()).toEqual(before)
        expect(emulator.faults.list().map(fault => fault.applied)).toEqual([0])
        expect(await controlPlaneText(emulator)).not.toContain(token)

        // The unused match-all fault still answers the next valid request.
        expect((await emulator.fetch(valid())).status).toBe(503)
        expect(emulator.faults.list().map(fault => fault.applied)).toEqual([1])
      })
    })
  }

  it('an admitted request keeps fixture text only: the bearer never reaches any record', async () => {
    await withEmulator({}, async emulator => {
      const session = await handshake(emulator)
      const answer = await emulator.fetch(onSession(recorded.legacyCallRead, session))
      const text = await answer.text()

      expect(answer.status).toBe(200)
      expect(text).not.toContain(token)
      expect(emulator.ledger.entries().at(-1)).toMatchObject({
        path: '/legacy/mcp',
        route: row(legacyUrl, 'tools/call'),
        headers: { 'mcp-session-id': session, accept: 'application/json, text/event-stream' },
        body: recorded.legacyCallRead.request.body
      })
      expect(await controlPlaneText(emulator)).not.toContain(token)
    })
  })
})

describe('the Afloat credential rule: afloat_ and a guarded remainder', () => {
  const remainder = afloatToken.slice(mcpEmulatorAfloatKeyPrefix.length)

  it('answers the reserved invalid Afloat credential the recorded 401, byte for byte', async () => {
    await withEmulator({}, async emulator => {
      const exchange = exchangeOf('mcp.auth.rejected.afloat.synthetic', 0)
      const answer = await emulator.fetch(requestFor(exchange, { bearer: afloatReserved }))

      expect(answer.status).toBe(401)
      expect(responseHeaders(answer)).toEqual(exchange.response.headers)
      expect(await answer.text()).toBe(recordedText(exchange))

      // The synthetic reserved credential is no Afloat key: it is not emulated there.
      expect((await emulator.fetch(requestFor(exchange, { bearer: reserved }))).status).toBe(400)

      const text = await controlPlaneText(emulator)

      expect(text).not.toContain(afloatReserved.slice(mcpEmulatorAfloatKeyPrefix.length))
      expect(text.toLowerCase()).not.toContain('bearer')
    })
  })

  const escaped = remainder.replace('s', '\\u0073')

  const repeats: ReadonlyArray<readonly [string, () => Request, string]> = [
    [
      'the whole key as the request id',
      () =>
        requestFor(recorded.afloatDiscover, {
          bearer: afloatToken,
          body: bodyWith(recorded.afloatDiscover, { id: afloatToken })
        }),
      'the request body repeats the credential'
    ],
    [
      'the remainder alone, JSON-escaped in the client info',
      () =>
        requestFor(recorded.afloatDiscover, {
          bearer: afloatToken,
          body: JSON.stringify(
            paramsWith(recorded.afloatDiscover, {
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': { name: 'ESCAPED', version: '1' },
                'io.modelcontextprotocol/clientCapabilities': {}
              }
            })
          ).replace('ESCAPED', escaped)
        }),
      'the request body repeats the credential'
    ],
    [
      'the remainder percent-encoded in a query value',
      () =>
        requestFor(recorded.afloatDiscover, {
          bearer: afloatToken,
          url: `${afloatUrl}?x=${remainder.replace('s', '%73')}`
        }),
      'the query repeats the credential'
    ],
    [
      'the remainder in the mcp-name header',
      () =>
        requestFor(recorded.afloatCallRead, {
          bearer: afloatToken,
          headers: { 'mcp-name': remainder }
        }),
      'a recorded request header repeats the credential'
    ],
    [
      'the whole key in a header the ledger does not record',
      () =>
        requestFor(recorded.afloatDiscover, {
          bearer: afloatToken,
          headers: { 'x-trace': afloatToken }
        }),
      'a request header repeats the credential'
    ]
  ]

  for (const [name, request, reason] of repeats) {
    it(`refuses ${name}: constant text, nothing kept or echoed`, async () => {
      await withEmulator({}, async emulator => {
        const before = emulator.snapshot()

        emulator.faults.add({ kind: 'status', status: 503 })

        const answer = await emulator.fetch(request())
        const text = await answer.text()

        expect(answer.status).toBe(400)
        expect(text).not.toContain(remainder)
        expect(emulator.ledger.entries().at(-1)).toMatchObject({
          path: '/<unrecognised>',
          query: {},
          headers: {},
          notEmulated: reason
        })
        expect(emulator.snapshot()).toEqual(before)
        expect(emulator.faults.list().map(fault => fault.applied)).toEqual([0])
        expect(await controlPlaneText(emulator)).not.toContain(remainder)

        // The unused match-all fault still answers the next valid request.
        expect((await emulator.fetch(valid())).status).toBe(503)
      })
    })
  }

  it('an admitted Afloat request keeps fixture text only: neither key nor remainder recorded', async () => {
    await withEmulator({}, async emulator => {
      const answer = await emulator.fetch(
        requestFor(recorded.afloatCallRead, { bearer: afloatToken })
      )

      const text = await answer.text()

      expect(answer.status).toBe(200)
      expect(text).toBe(recordedText(recorded.afloatCallRead))
      expect(emulator.ledger.entries().at(-1)).toMatchObject({
        path: '/mcp',
        route: row(afloatUrl, 'tools/call'),
        body: recorded.afloatCallRead.request.body
      })
      expect(await controlPlaneText(emulator)).not.toContain(remainder)
    })
  })

  it('a key whose remainder the answer holds is refused by the output guard', async () => {
    await withEmulator({}, async emulator => {
      const bearer = 'afloat_yolksyntheticinvoice0001'

      expect(recordedText(recorded.afloatCallRead)).toContain('yolksyntheticinvoice0001')

      emulator.faults.add({ kind: 'status', status: 503, count: 1 })

      const answer = await emulator.fetch(requestFor(recorded.afloatCallRead, { bearer }))
      const text = await answer.text()

      expect(answer.status).toBe(400)
      expect(JSON.parse(text)).toEqual({
        error: {
          type: 'not_emulated',
          message: 'Not emulated: the answer would repeat the credential'
        }
      })
      expect(text).not.toContain('yolksyntheticinvoice0001')
      expect(emulator.faults.list().map(fault => fault.applied)).toEqual([0])
    })
  })
})

describe('the output guard: no answer or stored value holds the bearer', () => {
  /** The refusal, its constant entry, no write, and an unused fault for the next valid request. */
  const expectGuarded = async (emulator: McpEmulator, answer: Response, bearer: string) => {
    const text = await answer.text()
    const headers = [...answer.headers.entries()].flat().join('\n')

    expect(answer.status).toBe(400)
    expect(JSON.parse(text)).toEqual({
      error: {
        type: 'not_emulated',
        message: 'Not emulated: the answer would repeat the credential'
      }
    })
    expect(`${text}\n${headers}`).not.toContain(bearer)
    expect(emulator.ledger.entries().at(-1)).toMatchObject({
      path: '/<unrecognised>',
      query: {},
      headers: {},
      status: 400,
      notEmulated: 'the answer would repeat the credential'
    })
    expect(emulator.ledger.entries().at(-1)?.body).toBeUndefined()
    expect(JSON.stringify(emulator.snapshot())).not.toContain(bearer)
    expect(await controlPlaneText(emulator)).not.toContain(bearer)
    expect(emulator.faults.list().map(fault => fault.applied)).toEqual([0])

    // The unused match-all fault still answers the next valid request.
    expect((await emulator.fetch(valid())).status).toBe(503)
  }

  it('Bearer yolk-emu-session-1 on a fresh emulator: initialize refused, nothing minted', async () => {
    await withEmulator({}, async emulator => {
      const bearer = 'yolk-emu-session-1'

      emulator.faults.add({ kind: 'status', status: 503, count: 1 })

      await expectGuarded(
        emulator,
        await emulator.fetch(requestFor(recorded.legacyInitialize, { bearer })),
        bearer
      )
      expect(emulator.snapshot().sessions).toEqual([])

      // The counter did not move: the next initialize (another bearer) mints the first session.
      expect(await handshake(emulator)).toBe('yolk-emu-session-1')
    })
  })

  it('Bearer synthetic-mcp against the discover answer naming yolk-synthetic-mcp', async () => {
    await withEmulator({}, async emulator => {
      const bearer = 'synthetic-mcp'

      expect(recordedText(recorded.modernDiscover)).toContain(`yolk-${bearer}`)

      emulator.faults.add({ kind: 'status', status: 503, count: 1 })

      await expectGuarded(
        emulator,
        await emulator.fetch(requestFor(recorded.modernDiscover, { bearer })),
        bearer
      )
    })
  })

  it('a bearer naming the minted cursor: the first page refused, no cursor issued', async () => {
    await withEmulator({ seed: { modernListing: 'two-pages' } }, async emulator => {
      const bearer = 'synthetic-cursor-0001'

      emulator.faults.add({ kind: 'status', status: 503, count: 1 })

      await expectGuarded(
        emulator,
        await emulator.fetch(requestFor(recorded.modernList, { bearer })),
        bearer
      )

      const state = await emulator
        .fetch(new Request(`${mcpEmulatorOrigin}/_emulate/state`))
        .then(response => response.json())

      expect(state.issuedCursor).toBeNull()
    })
  })
})

describe('legacy sessions', () => {
  it('mints yolk-emu-session-<n> from a counter reset and seed never rewind; both clear the sessions', async () => {
    await withEmulator({}, async emulator => {
      expect(await handshake(emulator)).toBe('yolk-emu-session-1')
      expect(await handshake(emulator, 'initializing')).toBe('yolk-emu-session-2')
      expect(emulator.snapshot().sessions).toEqual([
        { id: 'yolk-emu-session-1', phase: 'ready' },
        { id: 'yolk-emu-session-2', phase: 'initializing' }
      ])

      await emulator.reset()
      expect(emulator.snapshot().sessions).toEqual([])
      expect(await handshake(emulator)).toBe('yolk-emu-session-3')

      await emulator.seed({})
      expect(emulator.snapshot().sessions).toEqual([])
      expect(await handshake(emulator)).toBe('yolk-emu-session-4')

      // The ledger clear never rewinds it either.
      emulator.ledger.clear()
      expect(await handshake(emulator)).toBe('yolk-emu-session-5')
    })
  })

  it('a ready session answers tools/list, tools/call, and the standing GET with its own id', async () => {
    await withEmulator({}, async emulator => {
      const first = await handshake(emulator)
      const second = await handshake(emulator)

      for (const session of [first, second]) {
        for (const exchange of [recorded.legacyList, recorded.legacyCallRead, recorded.legacyGet]) {
          const answer = await emulator.fetch(onSession(exchange, session))

          expect(answer.status).toBe(exchange.response.status)
          expect(answer.headers.get('mcp-session-id')).toBe(
            exchange.response.headers['mcp-session-id'] === undefined ? null : session
          )
          expect(await answer.text()).toBe(recordedText(exchange))
        }
      }
    })
  })

  it(`holds at most ${mcpEmulatorSessionCap} sessions: another initialize is refused before any fault`, async () => {
    await withEmulator({}, async emulator => {
      for (let index = 0; index < mcpEmulatorSessionCap; index += 1) {
        await handshake(emulator, 'initializing')
      }

      const before = emulator.snapshot()

      emulator.faults.add({ kind: 'status', status: 503 })

      const refused = await emulator.fetch(requestFor(recorded.legacyInitialize))

      expect(refused.status).toBe(400)
      expect(emulator.ledger.entries().at(-1)?.notEmulated).toBe(
        'the emulator holds as many sessions as it takes'
      )
      expect(emulator.snapshot()).toEqual(before)
      expect(emulator.faults.list().map(fault => fault.applied)).toEqual([0])

      // The unused match-all fault still answers the next valid request.
      expect((await emulator.fetch(valid())).status).toBe(503)
      expect(emulator.faults.list().map(fault => fault.applied)).toEqual([1])

      await emulator.reset()
      expect(await handshake(emulator)).toBe(`yolk-emu-session-${mcpEmulatorSessionCap + 1}`)
    })
  })
})

describe('the paged modern listing: cursors by issuance', () => {
  const page = (emulator: McpEmulator, exchange: McpRecordedExchange, cursor?: string) =>
    emulator.fetch(
      requestFor(exchange, cursor === undefined ? {} : { body: paramsWith(exchange, { cursor }) })
    )

  it('the recorded cursor in its first generation, a minted one after each reset or seed', async () => {
    await withEmulator({ seed: { modernListing: 'two-pages' } }, async emulator => {
      const first = await page(emulator, recorded.modernList)

      expect((await first.json()).result.nextCursor).toBe('synthetic-cursor-0001')
      expect((await page(emulator, recorded.modernSecondPage)).status).toBe(200)

      await emulator.reset()

      // The old cursor crosses no reset.
      expect((await page(emulator, recorded.modernSecondPage)).status).toBe(400)

      const again = await page(emulator, recorded.modernList)

      expect((await again.json()).result.nextCursor).toBe('synthetic-cursor-0001.g2')
      expect((await page(emulator, recorded.modernSecondPage)).status).toBe(400)
      expect(
        (await page(emulator, recorded.modernSecondPage, 'synthetic-cursor-0001.g2')).status
      ).toBe(200)

      await emulator.seed({ modernListing: 'two-pages' })
      expect(
        (await page(emulator, recorded.modernSecondPage, 'synthetic-cursor-0001.g2')).status
      ).toBe(400)
      expect((await (await page(emulator, recorded.modernList)).json()).result.nextCursor).toBe(
        'synthetic-cursor-0001.g3'
      )

      // A one-page seed answers the one-page listing and no cursor at all.
      await emulator.seed({})

      const single = await page(emulator, recorded.modernList)

      expect(await single.text()).toBe(recordedText(recorded.modernList))
      expect(
        (await page(emulator, recorded.modernSecondPage, 'synthetic-cursor-0001.g3')).status
      ).toBe(400)
    })
  })
})

describe('a stale cursor', () => {
  it('is refused before any fault, writes nothing, and leaves the fault unused', async () => {
    await withEmulator({ seed: { modernListing: 'two-pages' } }, async emulator => {
      await (await emulator.fetch(requestFor(recorded.modernList))).text()
      await emulator.reset()

      const before = emulator.snapshot()

      emulator.faults.add({ kind: 'status', status: 503 })

      const refused = await emulator.fetch(requestFor(recorded.modernSecondPage))

      expect(refused.status).toBe(400)
      expect(emulator.ledger.entries().at(-1)).toMatchObject({
        path: '/<unrecognised>',
        notEmulated:
          'a cursor this emulator did not issue since the last reset or seed is not emulated'
      })
      expect(emulator.snapshot()).toEqual(before)
      expect(emulator.faults.list().map(fault => fault.applied)).toEqual([0])

      // The unused match-all fault still answers the next valid request.
      expect((await emulator.fetch(valid())).status).toBe(503)
      expect(emulator.faults.list().map(fault => fault.applied)).toEqual([1])
    })
  })
})

describe('faults', () => {
  it('a status fault matched by row answers only that row', async () => {
    await withEmulator({}, async emulator => {
      emulator.faults.add({
        kind: 'status',
        status: 429,
        headers: { 'retry-after': '1' },
        match: { route: row(modernUrl, 'tools/list') },
        count: 1
      })

      expect((await emulator.fetch(requestFor(recorded.modernDiscover))).status).toBe(200)

      const faulted = await emulator.fetch(requestFor(recorded.modernList))

      expect(faulted.status).toBe(429)
      expect(faulted.headers.get('retry-after')).toBe('1')
      expect((await emulator.fetch(requestFor(recorded.modernList))).status).toBe(200)
    })
  })

  it('truncates a JSON answer to no body; a truncation of a bodiless answer cannot apply', async () => {
    await withEmulator({}, async emulator => {
      emulator.faults.add({
        kind: 'truncate-after-chunks',
        chunks: 0,
        match: { route: row(modernUrl, 'server/discover') },
        count: 1
      })

      const truncated = await emulator.fetch(requestFor(recorded.modernDiscover))

      expect(truncated.status).toBe(200)
      expect(await truncated.text()).toBe('')

      emulator.faults.add({
        kind: 'truncate-after-chunks',
        chunks: 0,
        match: { route: row(legacyUrl, 'notifications/initialized') }
      })

      const session = await handshake(emulator, 'initializing')
      const refused = await emulator.fetch(onSession(recorded.legacyInitialized, session))

      // The 202 has no chunk to cut: 500, the fault unused, nothing written.
      expect(refused.status).toBe(500)
      expect(emulator.faults.list().map(fault => fault.applied)).toEqual([1, 0])
      expect(emulator.snapshot().sessions).toEqual([{ id: session, phase: 'initializing' }])
    })
  })

  it('a truncated initialize answers the cut answer and mints nothing', async () => {
    await withEmulator({}, async emulator => {
      emulator.faults.add({
        kind: 'truncate-after-chunks',
        chunks: 1,
        match: { route: row(legacyUrl, 'initialize') },
        count: 1
      })

      const truncated = await emulator.fetch(requestFor(recorded.legacyInitialize))

      const chunks =
        'chunks' in recorded.legacyInitialize.response
          ? recorded.legacyInitialize.response.chunks
          : []

      expect(truncated.status).toBe(200)
      expect(await truncated.text()).toBe(chunks[0])
      expect(emulator.ledger.entries().at(-1)?.fault).toBe('truncate-after-chunks')

      // No session held (the cap untouched), and the counter did not move.
      expect(emulator.snapshot().sessions).toEqual([])
      expect(await handshake(emulator)).toBe('yolk-emu-session-1')
      expect(emulator.snapshot().sessions).toHaveLength(1)
    })
  })

  it('a truncated first page issues no cursor: its continuation is refused', async () => {
    await withEmulator({ seed: { modernListing: 'two-pages' } }, async emulator => {
      emulator.faults.add({
        kind: 'truncate-after-chunks',
        chunks: 0,
        match: { route: row(modernUrl, 'tools/list') },
        count: 1
      })

      const truncated = await emulator.fetch(requestFor(recorded.modernList))

      expect(truncated.status).toBe(200)
      expect(await truncated.text()).toBe('')

      const state = await emulator
        .fetch(new Request(`${mcpEmulatorOrigin}/_emulate/state`))
        .then(response => response.json())

      expect(state.issuedCursor).toBeNull()
      expect((await emulator.fetch(requestFor(recorded.modernSecondPage))).status).toBe(400)

      // A first page answered whole issues it.
      await (await emulator.fetch(requestFor(recorded.modernList))).text()
      expect((await emulator.fetch(requestFor(recorded.modernSecondPage))).status).toBe(200)
    })
  })

  it('a faulted request writes nothing', async () => {
    await withEmulator({}, async emulator => {
      emulator.faults.add({ kind: 'status', status: 500, count: 1 })

      expect((await emulator.fetch(requestFor(recorded.legacyInitialize))).status).toBe(500)
      expect(emulator.snapshot().sessions).toEqual([])
      // The counter did not move either: the next session is the first.
      expect(await handshake(emulator)).toBe('yolk-emu-session-1')
    })
  })
})

describe('seeds, options, and the control plane', () => {
  it('rejects an invalid seed (sessions are never seeded) or drill knob', async () => {
    // Parsed from JSON, as a host passing untyped input would.
    const invalid: ReadonlyArray<readonly [McpEmulatorOptions, string]> = JSON.parse(
      JSON.stringify([
        [{ seed: { modernListing: 'three-pages' } }, 'Invalid MCP emulator seed'],
        [{ seed: { sessions: [] } }, 'Invalid MCP emulator seed'],
        [{ drills: { unknownKnob: true } }, 'unknown drill knob unknownKnob'],
        [{ drills: { writeToolMarkedReadOnly: 'yes' } }, 'must be a boolean']
      ])
    )

    for (const [options, message] of invalid) {
      const thrown = await makeMcpEmulator(options).then(
        () => undefined,
        (error: unknown) => error
      )

      expect(thrown).toBeInstanceOf(McpEmulatorInputInvalid)
      expect(String(thrown)).toContain(message)
    }
  })

  it('seeds over the control plane and reports runtime data', async () => {
    await withEmulator({}, async emulator => {
      const seeded = await emulator.fetch(
        new Request(`${mcpEmulatorOrigin}/_emulate/seed`, {
          method: 'POST',
          body: JSON.stringify({ modernListing: 'two-pages' })
        })
      )

      expect(await seeded.json()).toEqual({ seeded: true, modernListing: 'two-pages' })

      const invalid = await emulator.fetch(
        new Request(`${mcpEmulatorOrigin}/_emulate/seed`, {
          method: 'POST',
          body: JSON.stringify({ sessions: [{ id: 'yolk-emu-session-1', phase: 'ready' }] })
        })
      )

      expect(invalid.status).toBe(400)

      const state = await emulator
        .fetch(new Request(`${mcpEmulatorOrigin}/_emulate/state`))
        .then(response => response.json())

      expect(state).toMatchObject({
        state: { modernListing: 'two-pages', sessions: [] },
        nextSession: 1,
        cursorGeneration: 2,
        issuedCursor: null
      })
    })
  })
})
