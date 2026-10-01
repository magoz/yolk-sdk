/**
 * LinkedIn search emulator unit tests: the manifest, the fixture data copies, the drift test
 * (every fixture replayed and each complete response compared byte for byte; nothing is minted,
 * so nothing is substituted), the documented request-shape latitude, fail-closed 400
 * not-emulated answers that change no state and use up no fault, the constant-text ledger of
 * unrecognised requests and Authorization headers, the bearer and the rejected keys never
 * ledgered, stored, or echoed, the per-origin rejected keys, origins, faults through the real
 * connector, seeds, and the control plane. Tests may import SDK packages; the emulator source
 * never does.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, it } from '@effect/vitest'
import * as Schema from 'effect/Schema'
import { isWireBase64BodyResponse, isWireStreamResponse } from '@yolk-sdk/conformance/fixture'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import {
  LinkedInProfileInput,
  LinkedInSearchInput,
  linkedInProfileAction,
  linkedInSearchAction
} from '@yolk-sdk/connectors/linkedin-search'
import {
  linkedInSearchConformanceCases,
  linkedInSearchConformanceCredentials,
  linkedInSearchConformanceFixtureSeeds,
  linkedInSearchConformanceFixtures,
  linkedInSearchConformanceIntegration,
  linkedInSearchEnrichLayerUnauthorizedFixture,
  linkedInSearchExaUnauthorizedFixture
} from '@yolk-sdk/connectors/linkedin-search/conformance'
import {
  LinkedInSearchEmulatorInputInvalid,
  emulatorEvidenceHeader,
  linkedInSearchEmulatorEnrichLayerOrigin,
  linkedInSearchEmulatorErrorBodies,
  linkedInSearchEmulatorExaOrigin,
  linkedInSearchEmulatorRoutes,
  makeLinkedInSearchEmulator,
  type LinkedInSearchEmulator,
  type LinkedInSearchEmulatorOptions
} from '../src/linkedin-search.ts'
import { startFetchHandlerServer } from '../src/node.ts'
import { EmulatorRoute, InProcessHttpClient } from '../src/router.ts'

const exa = linkedInSearchEmulatorExaOrigin

const enrichLayer = linkedInSearchEmulatorEnrichLayerOrigin

/** A synthetic key the emulator accepts (never account data). */
const token = 'synthetic-linkedin-unit-key'

/** The synthetic invalid keys the unauthorized cases send (the default seed rejects them). */
const rejectedExaKey = 'yolk-conformance-invalid-exa-key'

const rejectedEnrichLayerKey = 'yolk-conformance-invalid-enrich-layer-key'

const seeds = linkedInSearchConformanceFixtureSeeds

const open: Array<LinkedInSearchEmulator> = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(emulator => emulator.close()))
})

const emulator = async (
  options: LinkedInSearchEmulatorOptions = {}
): Promise<LinkedInSearchEmulator> => {
  const created = await makeLinkedInSearchEmulator(options)

  open.push(created)

  return created
}

type CallOptions = {
  readonly body?: unknown
  readonly rawBody?: string
  readonly authorization?: string | null
  readonly contentType?: string
  readonly origin?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly handler?: (request: Request) => Promise<Response>
}

const call = (
  target: LinkedInSearchEmulator,
  method: string,
  url: string,
  options: CallOptions = {}
): Promise<Response> => {
  const headers = new Headers({ 'user-agent': 'yolk-sdk-connectors', ...options.headers })

  const authorization =
    options.authorization === undefined ? `Bearer ${token}` : options.authorization

  if (authorization !== null) headers.set('authorization', authorization)

  const body =
    options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body))

  if (body !== undefined) headers.set('content-type', options.contentType ?? 'application/json')

  const requestUrl =
    options.origin === undefined ? url : url.replace(/^https:\/\/[^/]+/, options.origin)

  return (options.handler ?? target.fetch)(new Request(requestUrl, { method, headers, body }))
}

/** The search body the connector sends. */
const searchBody = (overrides: Readonly<Record<string, Schema.Json>> = {}) => ({
  query: seeds.searchQuery,
  category: 'people',
  numResults: 10,
  type: 'auto',
  contents: { text: true },
  ...overrides
})

const search = (
  target: LinkedInSearchEmulator,
  overrides: Readonly<Record<string, Schema.Json>> = {},
  options: CallOptions = {}
) => call(target, 'POST', `${exa}/search`, { body: searchBody(overrides), ...options })

const profileUrl = (url: string = seeds.profileUrl ?? '') =>
  `${enrichLayer}/api/v2/profile?linkedin_profile_url=${encodeURIComponent(url)}`

const emailUrl = (url: string = seeds.profileUrl ?? '') =>
  `${enrichLayer}/api/v2/profile/email?linkedin_profile_url=${encodeURIComponent(url)}`

/** Assert a 400 not-emulated naming `reason`; returns the raw response (headers and body text). */
const expectNotEmulated = async (response: Response, reason: string): Promise<string> => {
  expect(response.status).toBe(400)

  const text = await response.text()
  const body: unknown = JSON.parse(text)

  expect(body).toEqual({ error: { type: 'not_emulated', message: expect.any(String) } })
  expect(JSON.stringify(body)).toContain(reason)

  return [...response.headers]
    .map(([name, value]) => `${name}: ${value}`)
    .concat(text)
    .join('\n')
}

const validRequest = (target: LinkedInSearchEmulator) => search(target)

/**
 * Every refusal: 400 not-emulated naming `reason`, the state unchanged, and a match-all fault
 * installed beforehand left unused, still answering the next valid request.
 */
const expectRefusedWithoutFault = async (
  target: LinkedInSearchEmulator,
  send: () => Promise<Response>,
  reason: string
): Promise<string> => {
  const seed = target.snapshot()

  target.faults.clear()
  target.faults.add({ kind: 'status', status: 503, count: 1 })

  const text = await expectNotEmulated(await send(), reason)

  expect(target.snapshot()).toEqual(seed)
  expect(target.faults.list()[0]).toMatchObject({ applied: 0, remaining: 1 })
  expect(target.ledger.entries().at(-1)).toMatchObject({ status: 400 })
  expect(target.ledger.entries().at(-1)?.notEmulated).toContain(reason)
  expect(target.ledger.entries().at(-1)?.fault).toBeUndefined()

  expect((await validRequest(target)).status).toBe(503)
  expect(target.faults.list()[0]).toMatchObject({ applied: 1, remaining: 0 })

  return text
}

/** Every `/_emulate/*` read, as text. */
const controlReads = (target: LinkedInSearchEmulator) =>
  Promise.all(
    ['ledger', 'state', 'coverage', 'faults'].map(route =>
      target.fetch(new Request(`${exa}/_emulate/${route}`)).then(response => response.text())
    )
  )

const isResults = Schema.is(Schema.Struct({ results: Schema.Array(Schema.Json) }))

const digest = (key: string, origin: string) =>
  createHash('sha256').update(`${origin} ${key}`).digest('hex')

describe('route evidence manifest', () => {
  it('lists every route as an unverified connector read linked to LinkedIn search cases', () => {
    const caseIds = new Set(linkedInSearchConformanceCases.map(testCase => testCase.id))

    expect(linkedInSearchEmulatorRoutes.map(route => `${route.method} ${route.path}`)).toEqual([
      'POST /search',
      'GET /api/v2/profile',
      'GET /api/v2/profile/email'
    ])

    for (const route of linkedInSearchEmulatorRoutes) {
      expect(Object.keys(route).sort()).toEqual([
        'caseIds',
        'evidence',
        'kind',
        'method',
        'path',
        'write'
      ])
      expect(route).toMatchObject({ kind: 'connector', evidence: 'unverified', write: false })
      expect(route.caseIds.length, route.path).toBeGreaterThan(0)
      expect(route.caseIds.every(caseId => caseIds.has(caseId))).toBe(true)
    }

    expect(new Set(linkedInSearchEmulatorRoutes.flatMap(route => route.caseIds))).toEqual(caseIds)
  })

  it('has a handler behind every manifest route', async () => {
    const target = await emulator()

    await search(target)
    await call(target, 'GET', profileUrl())
    await call(target, 'GET', emailUrl())

    expect(target.coverage().routes.every(route => route.requests === 1)).toBe(true)
    expect(target.coverage().unknownRouteRequests).toBe(0)
    expect(target.ledger.entries().map(entry => entry.status)).toEqual([200, 200, 200])
    expect(target.ledger.entries().every(entry => entry.evidence === 'unverified')).toBe(true)
  })
})

/** The recorded body text of a response (the LinkedIn search fixtures record text bodies). */
const recordedText = (
  response: (typeof linkedInSearchConformanceFixtures)[number]['exchanges'][number]['response']
) => {
  if (isWireStreamResponse(response) || isWireBase64BodyResponse(response)) {
    throw new Error('LinkedIn search fixtures record text bodies only')
  }

  return response.body ?? ''
}

describe('fixture data copies', () => {
  it('the default seed holds the fixture seeds and only digests of the rejected keys', async () => {
    const state = (await emulator()).snapshot()

    expect([...new Set(state.searches.map(entry => entry.query))]).toEqual([seeds.searchQuery])
    expect(state.searches.map(entry => entry.numResults)).toEqual([10, 3, 2])
    expect(state.profiles.map(entry => entry.url)).toEqual([seeds.profileUrl])
    expect(state.absentProfileUrls).toEqual([seeds.absentProfileUrl])
    expect(state.exaRejectedKeyDigests).toEqual([digest(rejectedExaKey, exa)])
    expect(state.enrichLayerRejectedKeyDigests).toEqual([
      digest(rejectedEnrichLayerKey, enrichLayer)
    ])

    const text = JSON.stringify(state)

    expect(text).not.toContain(rejectedExaKey)
    expect(text).not.toContain(rejectedEnrichLayerKey)
  })

  it('the error bodies are the fixtures, byte for byte', () => {
    const recordedBodies = linkedInSearchConformanceFixtures
      .flatMap(fixture => fixture.exchanges)
      .map(exchange => exchange.response)
      .filter(response => response.status >= 400)
      .map(recordedText)

    expect(new Set(recordedBodies)).toEqual(
      new Set(Object.values(linkedInSearchEmulatorErrorBodies).map(body => JSON.stringify(body)))
    )
  })

  it('the fixtures carry only synthetic data (no key, example hosts only)', () => {
    const text = JSON.stringify(linkedInSearchConformanceFixtures)

    for (const host of text.match(/https?:\/\/[^/"\\]+/g) ?? []) {
      expect([
        'https://api.exa.ai',
        'https://enrichlayer.com',
        'https://linkedin.example.com'
      ]).toContain(host)
    }

    expect(text.toLowerCase()).not.toContain('authorization')
  })
})

type Fixture = (typeof linkedInSearchConformanceFixtures)[number]

/** The bearer each fixture is replayed with: the rejected key for the unauthorized ones. */
const fixtureKey = (fixture: Fixture): string =>
  fixture.id === linkedInSearchExaUnauthorizedFixture.id
    ? rejectedExaKey
    : fixture.id === linkedInSearchEnrichLayerUnauthorizedFixture.id
      ? rejectedEnrichLayerKey
      : token

/** Send every request of `fixture` and answer the responses. */
const replay = async (target: LinkedInSearchEmulator, fixture: Fixture) => {
  const answers: Array<{ readonly response: Response; readonly text: string }> = []

  for (const exchange of fixture.exchanges) {
    const headers = new Headers(exchange.request.headers)

    headers.set('authorization', `Bearer ${fixtureKey(fixture)}`)

    const body = exchange.request.body

    const response = await target.fetch(
      new Request(exchange.request.url, {
        method: exchange.request.method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    )

    answers.push({ response, text: await response.text() })
  }

  return answers
}

/** Status, every header (the evidence header aside), and the body text equal the recording. */
const expectRecorded = (
  fixture: Fixture,
  answers: ReadonlyArray<{ readonly response: Response; readonly text: string }>
) => {
  expect(answers).toHaveLength(fixture.exchanges.length)

  for (const [index, exchange] of fixture.exchanges.entries()) {
    const label = `${index} ${exchange.request.method} ${exchange.request.url}`
    const answer = answers[index]

    if (answer === undefined) throw new Error(label)

    const { response, text } = answer

    expect(response.status, label).toBe(exchange.response.status)
    expect(response.headers.get(emulatorEvidenceHeader), label).toBe('unverified')
    expect(
      Object.fromEntries([...response.headers].filter(([name]) => name !== emulatorEvidenceHeader)),
      label
    ).toEqual(exchange.response.headers)
    expect(text, label).toBe(recordedText(exchange.response))
  }
}

describe('drift: every fixture replayed, each complete response byte for byte', () => {
  // Nothing is minted (no ids, cursors, or clock), so nothing is substituted.
  it.each(linkedInSearchConformanceFixtures.map(fixture => [fixture.id, fixture] as const))(
    '%s',
    async (_id, fixture) => {
      const target = await emulator()

      expectRecorded(fixture, await replay(target, fixture))
      expect(target.ledger.entries().every(entry => entry.notEmulated === undefined)).toBe(true)
    }
  )

  it('every fixture in suite order on ONE emulator, twice, the state unchanged', async () => {
    const target = await emulator()
    const seed = target.snapshot()

    for (const _pass of [1, 2]) {
      for (const fixture of linkedInSearchConformanceFixtures) {
        expectRecorded(fixture, await replay(target, fixture))
      }
    }

    expect(target.snapshot()).toEqual(seed)
    expect(target.ledger.entries().every(entry => entry.notEmulated === undefined)).toBe(true)
  })
})

describe('request-shape latitude', () => {
  it('accepts JSON key order, content-type parameters, and extra headers', async () => {
    const target = await emulator()
    const recorded = await (await search(target)).text()

    const reordered = await call(target, 'POST', `${exa}/search`, {
      rawBody: JSON.stringify({
        contents: { text: true },
        type: 'auto',
        numResults: 10,
        category: 'people',
        query: seeds.searchQuery
      }),
      contentType: 'application/json; charset=utf-8',
      headers: { accept: 'application/json', 'x-synthetic-extra': '1' }
    })

    expect(reordered.status).toBe(200)
    expect(await reordered.text()).toBe(recorded)
  })

  it('accepts any percent-encoding of the profile URL that decodes once to it', async () => {
    const target = await emulator()
    const raw = `${enrichLayer}/api/v2/profile?linkedin_profile_url=${seeds.profileUrl}`
    const answered = await call(target, 'GET', raw)

    expect(answered.status).toBe(200)
    expect(await answered.json()).toMatchObject({ public_identifier: 'synthetic-person-01' })
    expect(target.ledger.entries()[0]?.query).toEqual({ linkedin_profile_url: seeds.profileUrl })
  })

  it('a rejected key answers the recorded 401 for any well-formed request there', async () => {
    const target = await emulator()
    const exaKey = { authorization: `Bearer ${rejectedExaKey}` }
    const enrichKey = { authorization: `Bearer ${rejectedEnrichLayerKey}` }

    const answers = [
      await search(target, {}, exaKey),
      await search(target, { query: 'another synthetic query', numResults: 100 }, exaKey),
      await search(target, { numResults: 1 }, exaKey),
      await call(target, 'GET', profileUrl('https://linkedin.example.com/in/other'), enrichKey),
      await call(target, 'GET', emailUrl(seeds.absentProfileUrl), enrichKey)
    ]

    expect(answers.map(response => response.status)).toEqual([401, 401, 401, 401, 401])
    expect(await answers[0]?.text()).toBe(
      JSON.stringify(linkedInSearchEmulatorErrorBodies.exaUnauthorized)
    )
    expect(await answers[4]?.text()).toBe(
      JSON.stringify(linkedInSearchEmulatorErrorBodies.enrichLayerUnauthorized)
    )
  })

  it('rejected keys are per origin: one origin rejected key is accepted on the other', async () => {
    const target = await emulator()

    // The Enrich Layer invalid key on Exa, and the Exa invalid key on Enrich Layer.
    const searched = await search(target, {}, { authorization: `Bearer ${rejectedEnrichLayerKey}` })

    const looked = await call(target, 'GET', profileUrl(), {
      authorization: `Bearer ${rejectedExaKey}`
    })

    expect([searched.status, looked.status]).toEqual([200, 200])
  })

  it('answers each seeded numResults with its results, the profile, and the email', async () => {
    const target = await emulator()

    const counts = await Promise.all(
      [10, 3, 2].map(async numResults => {
        const body: unknown = await (await search(target, { numResults })).json()

        return isResults(body) ? body.results.length : -1
      })
    )

    expect(counts).toEqual([3, 3, 2])
    expect(await (await call(target, 'GET', emailUrl())).json()).toEqual({
      email: 'synthetic-person-01@example.com'
    })
    expect((await call(target, 'GET', profileUrl(seeds.absentProfileUrl))).status).toBe(404)
  })
})

describe('the request-shape latitude bullet', () => {
  /** The bullet's text in a file, without comment markers, list markers, emphasis, or wrapping. */
  const bulletIn = (relative: string): string => {
    const text = readFileSync(new URL(relative, import.meta.url), 'utf8')
    const start = text.indexOf('Request-shape latitude (`/linkedin-search`')
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
      '../src/linkedin-search.ts',
      '../AGENTS.md',
      '../README.md',
      '../../../apps/docs/content/docs/api-reference/emulators.mdx'
    ].map(bulletIn)

    expect(new Set(copies).size, copies.join('\n\n')).toBe(1)
  })
})

describe('fail closed: 400 not-emulated, state unchanged, a matching fault left unused', () => {
  it.each([
    ['an unseeded query', () => searchBody({ query: 'unseeded synthetic query' }), 'no answer for'],
    ['an unseeded numResults', () => searchBody({ numResults: 5 }), 'no answer for'],
    // The unauthorized probe with an accepted key: no fixture records its answer.
    [
      'the unauthorized probe with an accepted key',
      () => searchBody({ query: 'yolk-conformance unauthorized probe' }),
      'no answer for'
    ],
    ['numResults 0', () => searchBody({ numResults: 0 }), 'numResults must be an integer'],
    ['numResults 101', () => searchBody({ numResults: 101 }), 'numResults must be an integer'],
    ['numResults 1.5', () => searchBody({ numResults: 1.5 }), 'numResults must be an integer'],
    ['numResults as text', () => searchBody({ numResults: '10' }), 'numResults must be an integer'],
    ['another category', () => searchBody({ category: 'company' }), 'category other than people'],
    ['another type', () => searchBody({ type: 'neural' }), 'type other than auto'],
    ['contents without text', () => searchBody({ contents: { text: false } }), 'contents other'],
    [
      'contents with another key',
      () => searchBody({ contents: { text: true, highlights: true } }),
      'contents has a key this route does not take'
    ],
    [
      'an extra body key',
      () => searchBody({ includeDomains: ['linkedin.example.com'] }),
      'the search body has a key this route does not take'
    ],
    [
      'a missing body key',
      () => {
        const { type: _type, ...rest } = searchBody()

        return rest
      },
      "the search body without 'type'"
    ],
    ['an empty query', () => searchBody({ query: '' }), 'query must be one trimmed'],
    ['an untrimmed query', () => searchBody({ query: ' x' }), 'query must be one trimmed'],
    ['a two-line query', () => searchBody({ query: 'a\nb' }), 'query must be one trimmed'],
    ['an overlong query', () => searchBody({ query: 'x'.repeat(501) }), 'query must be one'],
    ['a body that is no object', () => [searchBody()], 'the search body must be a JSON object']
  ] as const)('search: %s', async (_label, body, reason) => {
    const target = await emulator()

    await expectRefusedWithoutFault(
      target,
      () => call(target, 'POST', `${exa}/search`, { body: body() }),
      reason
    )
  })

  it.each([
    ['a query parameter on the search', 'POST', `${exa}/search?x=1`, 'a query parameter'],
    [
      'a profile URL the state does not hold',
      'GET',
      profileUrl(`${seeds.profileUrl}-x`),
      'neither'
    ],
    ['an email lookup of the absent profile', 'GET', emailUrl(seeds.absentProfileUrl), 'no email'],
    ['an email lookup of an unknown profile', 'GET', emailUrl(`${seeds.profileUrl}-x`), 'no email'],
    [
      'a URL that is no profile URL',
      'GET',
      profileUrl('https://linkedin.example.com/company/x'),
      'linkedin_profile_url must be a profile URL'
    ],
    [
      'a profile URL with a query',
      'GET',
      profileUrl(`${seeds.profileUrl}?x=1`),
      'linkedin_profile_url must be a profile URL'
    ],
    [
      'a missing linkedin_profile_url',
      'GET',
      `${enrichLayer}/api/v2/profile`,
      'without query parameter linkedin_profile_url'
    ],
    [
      'a repeated linkedin_profile_url',
      'GET',
      `${profileUrl()}&linkedin_profile_url=x`,
      'repeated query parameters'
    ],
    ['another query parameter', 'GET', `${profileUrl()}&extra=1`, 'a query parameter this route'],
    // A parameter name is compared raw: a percent-encoded spelling of the name is not emulated.
    ...[
      ['the profile', profileUrl()],
      ['the email', emailUrl()]
    ].flatMap(([lookup = '', url = '']) =>
      ['%6cinkedin_profile_url', '%6Cinkedin_profile_url', 'linkedin%5Fprofile_url'].map(
        name =>
          [
            `${name} on ${lookup} lookup`,
            'GET',
            url.replace('linkedin_profile_url=', `${name}=`),
            'a query parameter name in any but its plain form is not emulated'
          ] as const
      )
    ),
    ['an empty query component', 'GET', `${profileUrl()}&`, 'empty query components'],
    ['a bare ?', 'POST', `${exa}/search?`, 'empty query components'],
    ['the search on the Enrich Layer origin', 'POST', `${enrichLayer}/search`, 'recorded on'],
    [
      'a lookup on the Exa origin',
      'GET',
      `${exa}/api/v2/profile?linkedin_profile_url=x`,
      'recorded on'
    ]
  ] as const)('%s', async (_label, method, url, reason) => {
    const target = await emulator()

    await expectRefusedWithoutFault(
      target,
      () => call(target, method, url, method === 'POST' ? { body: searchBody() } : {}),
      reason
    )
  })

  it.each([
    [
      'a search without a JSON content type',
      (target: LinkedInSearchEmulator) =>
        call(target, 'POST', `${exa}/search`, {
          rawBody: JSON.stringify(searchBody()),
          contentType: 'text/plain'
        }),
      'content-type: application/json'
    ],
    [
      'a search body that is not JSON',
      (target: LinkedInSearchEmulator) =>
        call(target, 'POST', `${exa}/search`, { rawBody: '{"query":' }),
      'not valid JSON'
    ],
    [
      // A POST is no route shape on the lookup path: the constant unrecognised entry.
      'a POST to a lookup path',
      (target: LinkedInSearchEmulator) => call(target, 'POST', profileUrl(), { rawBody: '{}' }),
      'no emulated'
    ],
    [
      // Fetch's Request refuses a GET body, so the request is built as a POST and read as a GET
      // (the method the wrapper matches on): the route refuses its body.
      'a GET lookup carrying a body',
      (target: LinkedInSearchEmulator) => {
        const withBody = new Request(profileUrl(), {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          body: '{}'
        })

        Object.defineProperty(withBody, 'method', { value: 'GET' })

        return target.fetch(withBody)
      },
      'this route takes no request body'
    ],
    [
      'a missing Authorization header',
      (target: LinkedInSearchEmulator) =>
        call(target, 'POST', `${exa}/search`, { body: searchBody(), authorization: null }),
      'Authorization: Bearer'
    ]
  ] as const)('%s', async (_label, send, reason) => {
    const target = await emulator()

    await expectRefusedWithoutFault(target, () => send(target), reason)
  })
})

describe('a GET lookup with a body over loopback', () => {
  /** A raw HTTP GET with a body (fetch cannot send one) to a loopback server. */
  const rawGet = (url: string, body: string) =>
    new Promise<{ readonly status: number; readonly text: string }>((resolve, reject) => {
      const sent = httpRequest(
        url,
        {
          method: 'GET',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(body))
          }
        },
        response => {
          let text = ''

          response.setEncoding('utf8')
          response.on('data', (chunk: string) => {
            text += chunk
          })
          response.on('end', () => resolve({ status: response.statusCode ?? 0, text }))
        }
      )

      sent.on('error', reject)
      sent.end(body)
    })

  it('the loopback server drops a GET body before the emulator sees it', async () => {
    const target = await emulator()
    const server = await startFetchHandlerServer(target.fetchOn(enrichLayer))

    try {
      const path = new URL(profileUrl())

      const answered = await rawGet(
        `${server.url}${path.pathname}${path.search}`,
        `{"k":"${token}"}`
      )

      // The Node server builds the Request without a GET body (the Fetch API allows none), so
      // the emulator answers the plain lookup and nothing of the body is kept.
      expect(answered.status).toBe(200)
      expect(target.ledger.entries()).toHaveLength(1)
      expect(target.ledger.entries()[0]).not.toHaveProperty('body')
      expect(target.ledger.entries()[0]).not.toHaveProperty('bodyBytes')
      expect(
        [
          answered.text,
          JSON.stringify(target.ledger.entries()),
          ...(await controlReads(target))
        ].join('\n')
      ).not.toContain(token)
    } finally {
      await server.close()
    }
  })
})

describe('unrecognised requests are ledgered without request text', () => {
  const unrecognisedReason = 'no emulated Exa or Enrich Layer route for this method and path'

  it.each([
    ['GET', `${exa}/search?q=${token}`],
    ['POST', `${exa}/search/${token}`],
    ['POST', `${exa}/contents`],
    ['GET', `${enrichLayer}/api/v2/profile/`],
    ['GET', `${enrichLayer}/api/v2/profile/email/${token}`],
    ['GET', `${enrichLayer}/api/v2/person/${token}`],
    ['GET', `${enrichLayer}/api/v2/%70rofile?linkedin_profile_url=x`],
    ['DELETE', `${enrichLayer}/api/v2/profile?linkedin_profile_url=${token}`]
  ] as const)('%s %s', async (method, url) => {
    const target = await emulator()

    const text = await expectRefusedWithoutFault(
      target,
      () => call(target, method, url),
      unrecognisedReason
    )

    expect(target.ledger.entries()[0]).toEqual({
      seq: 1,
      method,
      path: '/<unrecognised>',
      query: {},
      headers: {},
      status: 400,
      evidence: 'unknown-route',
      notEmulated: unrecognisedReason
    })
    expect([text, JSON.stringify(target.ledger.entries())].join('\n')).not.toContain(token)
  })
})

describe('an unrecognisable Authorization header is ledgered without request text', () => {
  const secret = 'Q7LinkedInSecretValue'
  const reason = 'an unrecognisable Authorization header is not emulated'

  it.each([
    ['another scheme', `Token ${secret}`],
    ['a bearer shorter than 8 characters', 'Bearer short'],
    ['a lower-case scheme', `bearer ${secret}`],
    ['two spaces after the scheme', `Bearer  ${secret}`],
    ['extra words', `Bearer ${secret} extra`],
    ['duplicated headers combined', `Bearer ${secret}, Bearer ${secret}`],
    // A UUID-form key starts with a hex digit, so it can complete an escape to its left.
    ['a hex-first (UUID-form) key', 'Bearer 3f2a9c1e-0000-4000-8000-00000000c0de'],
    ['an all-number key', 'Bearer 12345678']
  ] as const)('%s', async (_label, authorization) => {
    const target = await emulator()

    const text = await expectRefusedWithoutFault(
      target,
      () =>
        call(target, 'POST', `${exa}/search?q=${secret}`, {
          body: searchBody({ query: secret }),
          authorization
        }),
      reason
    )

    expect(target.ledger.entries()[0]).toEqual({
      seq: 1,
      method: 'POST',
      path: '/<unrecognised>',
      query: {},
      headers: {},
      status: 400,
      evidence: 'unknown-route',
      notEmulated: reason
    })

    expect(
      [text, JSON.stringify(target.ledger.entries()), ...(await controlReads(target))].join('\n')
    ).not.toContain(secret)
  })
})

describe('the bearer value is never ledgered or echoed', () => {
  const secret = 'Q7LinkedInSecretValue'
  const bearer = { authorization: `Bearer ${secret}` }

  /** A key whose search is otherwise valid. */
  const send = (
    target: LinkedInSearchEmulator,
    method: string,
    url: string,
    options: CallOptions
  ) => call(target, method, url, { ...bearer, ...options })

  it.each([
    ['in a query value', 'GET', `${profileUrl()}&x=${secret}`, {}, 'the query repeats'],
    ['as a query key', 'GET', `${profileUrl()}&${secret}=1`, {}, 'the query repeats'],
    [
      'percent-encoded in a query value',
      'GET',
      `${profileUrl()}&x=${encodeURIComponent(secret).replace('Q', '%51')}`,
      {},
      'the query repeats'
    ],
    [
      'twice percent-encoded in the profile URL',
      'GET',
      profileUrl(`https://linkedin.example.com/in/${secret.replace('Q', '%2551')}`),
      {},
      'the query repeats'
    ],
    // No route takes a path parameter, so a path holding the bearer is no route shape at all.
    [
      'in the path',
      'POST',
      `${exa}/search/${secret}`,
      { body: searchBody() },
      'no emulated Exa or Enrich Layer route'
    ],
    [
      'in a body value',
      'POST',
      `${exa}/search`,
      { body: searchBody({ query: `see ${secret}` }) },
      'the request body repeats the credential'
    ],
    [
      'JSON-escaped in a body value',
      'POST',
      `${exa}/search`,
      {
        rawBody: JSON.stringify(searchBody()).replace(
          '"auto"',
          `"${secret.replace('L', '\\u004c')}"`
        )
      },
      'the request body repeats the credential'
    ],
    [
      'JSON-escaped as a body key',
      'POST',
      `${exa}/search`,
      { rawBody: `{"${secret.replace('L', '\\u004C')}":1}` },
      'the request body repeats the credential'
    ],
    [
      'in the recorded content-type header',
      'POST',
      `${exa}/search`,
      { body: searchBody(), contentType: `application/json; x=${secret}` },
      'a recorded request header repeats the credential'
    ]
  ] as const)('%s', async (_label, method, url, options, reason) => {
    const target = await emulator()

    const text = await expectRefusedWithoutFault(
      target,
      () => send(target, method, url, options),
      reason
    )

    // A request repeating the credential is ledgered with constant text only (or, on no route
    // shape, as the constant unrecognised entry).
    expect(target.ledger.entries().at(-2)).toMatchObject({
      method,
      path: '/<unrecognised>',
      query: {},
      headers: {},
      status: 400
    })

    const seen = [text, JSON.stringify(target.ledger.entries()), ...(await controlReads(target))]

    expect(seen.join('\n')).not.toContain(secret)
    expect(seen.join('\n')).not.toContain('nSecretValue')
  })

  it('answers recognised requests, rejected keys included, without any key anywhere', async () => {
    const target = await emulator()

    const responses = [
      await search(target),
      await search(target, {}, { authorization: `Bearer ${rejectedExaKey}` }),
      await call(target, 'GET', profileUrl(), {
        authorization: `Bearer ${rejectedEnrichLayerKey}`
      }),
      await call(target, 'GET', emailUrl()),
      await call(target, 'GET', profileUrl(seeds.absentProfileUrl)),
      // Refused by the state: the reason is scrubbed too.
      await search(target, { numResults: 4 })
    ]

    expect(responses.map(response => response.status)).toEqual([200, 401, 401, 200, 404, 400])

    const texts = await Promise.all(responses.map(response => response.text()))

    const seen = [
      ...texts,
      JSON.stringify(target.ledger.entries()),
      ...(await controlReads(target))
    ]

    for (const key of [token, rejectedExaKey, rejectedEnrichLayerKey]) {
      expect(seen.join('\n')).not.toContain(key)
    }
  })
})

describe('origins', () => {
  it('answers only on the recorded origin; fetchOn serves each behind a rewrite', async () => {
    const target = await emulator()
    const loopback = 'http://127.0.0.1:9'

    await expectNotEmulated(
      await search(target, {}, { origin: loopback }),
      'recorded on https://api.exa.ai only'
    )

    expect(
      (await search(target, {}, { origin: loopback, handler: target.fetchOn(exa) })).status
    ).toBe(200)

    const looked = await call(target, 'GET', profileUrl(), {
      origin: loopback,
      handler: target.fetchOn(enrichLayer)
    })

    expect(looked.status).toBe(200)

    // The rejected keys follow the arrival origin.
    const rejectedOnLoopback = await search(
      target,
      {},
      { origin: loopback, handler: target.fetchOn(exa), authorization: `Bearer ${rejectedExaKey}` }
    )

    expect(rejectedOnLoopback.status).toBe(401)

    await expectNotEmulated(
      await search(target, {}, { origin: loopback, handler: target.fetchOn(enrichLayer) }),
      'recorded on https://api.exa.ai only'
    )
  })
})

describe('faults', () => {
  const connectorLayer = (target: LinkedInSearchEmulator) =>
    Layer.mergeAll(
      connectorHttpClientsFromEffectHttpClientLayer.pipe(
        Layer.provide(
          InProcessHttpClient.layer([
            EmulatorRoute.handler(exa, target.fetch),
            EmulatorRoute.handler(enrichLayer, target.fetch)
          ])
        )
      ),
      staticCredentialResolverLayer(
        linkedInSearchConformanceCredentials({ exaApiKey: token, enrichLayerApiKey: token })
      )
    )

  it.effect('a 429 fault reaches the connector as linkedin_search_failed and changes nothing', () =>
    Effect.gen(function* () {
      const target = yield* Effect.promise(() => emulator())
      const seed = target.snapshot()

      target.faults.add({
        kind: 'status',
        status: 429,
        headers: { 'retry-after': '7' },
        match: { method: 'POST', path: '/search' },
        count: 1
      })

      const integration = linkedInSearchConformanceIntegration()

      const searched = yield* linkedInSearchAction
        .executeTyped({
          integration,
          input: LinkedInSearchInput.make({ query: seeds.searchQuery ?? '' })
        })
        .pipe(Effect.provide(connectorLayer(target)))

      expect(searched).toMatchObject({
        _tag: 'Failure',
        error: { code: 'linkedin_search_failed', status: 429 }
      })
      expect(target.snapshot()).toEqual(seed)
      expect(target.ledger.entries()[0]).toMatchObject({ status: 429, fault: 'status' })

      const looked = yield* linkedInProfileAction
        .executeTyped({
          integration,
          input: LinkedInProfileInput.make({ linkedinUrl: seeds.profileUrl ?? '' })
        })
        .pipe(Effect.provide(connectorLayer(target)))

      expect(looked).toMatchObject({ _tag: 'Success' })
    })
  )

  it('answers the default emulator-fault body; validates faults (400-599, headers)', async () => {
    const target = await emulator()

    target.faults.add({ kind: 'status', status: 500, count: 1 })

    const faulted = await validRequest(target)

    expect(faulted.status).toBe(500)
    expect(await faulted.json()).toEqual({
      error: { type: 'emulator_fault', message: 'Emulator fault: status 500.' }
    })
    expect(() => target.faults.add({ kind: 'status', status: 204 })).toThrow(
      LinkedInSearchEmulatorInputInvalid
    )
    expect(() =>
      target.faults.add({ kind: 'status', status: 503, headers: { location: '/x' } })
    ).toThrow(LinkedInSearchEmulatorInputInvalid)
  })

  it('a fault answers a rejected-key request (an answered one), never a refusal', async () => {
    const target = await emulator()

    target.faults.add({ kind: 'status', status: 503, count: 1 })

    await expectNotEmulated(await search(target, { numResults: 7 }), 'no answer for')
    expect(target.faults.list()[0]).toMatchObject({ applied: 0 })

    const faulted = await search(target, {}, { authorization: `Bearer ${rejectedExaKey}` })

    expect(faulted.status).toBe(503)
    expect(target.faults.list()[0]).toMatchObject({ applied: 1, remaining: 0 })
  })
})

describe('seeds', () => {
  it('replaces parts of the default seed', async () => {
    const custom = await emulator({
      seed: {
        searches: [
          {
            query: 'another synthetic query',
            numResults: 1,
            results: [{ url: 'https://linkedin.example.com/in/synthetic-person-09' }]
          }
        ],
        profiles: [],
        absentProfileUrls: [seeds.profileUrl ?? ''],
        exaRejectedKeys: ['synthetic-rejected-exa-key'],
        enrichLayerRejectedKeys: []
      }
    })

    expect(
      await (await search(custom, { query: 'another synthetic query', numResults: 1 })).text()
    ).toBe('{"results":[{"url":"https://linkedin.example.com/in/synthetic-person-09"}]}')
    await expectNotEmulated(await search(custom), 'no answer for')
    expect((await call(custom, 'GET', profileUrl())).status).toBe(404)
    await expectNotEmulated(await call(custom, 'GET', emailUrl()), 'no email')
    // The default rejected keys are replaced: the old ones are accepted, the seeded one is not.
    expect(
      (
        await search(
          custom,
          { query: 'another synthetic query', numResults: 1 },
          { authorization: `Bearer ${rejectedExaKey}` }
        )
      ).status
    ).toBe(200)
    expect(
      (await search(custom, {}, { authorization: 'Bearer synthetic-rejected-exa-key' })).status
    ).toBe(401)
    expect(
      (
        await call(custom, 'GET', profileUrl(), {
          authorization: `Bearer ${rejectedEnrichLayerKey}`
        })
      ).status
    ).toBe(404)
    expect(JSON.stringify(custom.snapshot())).not.toContain('synthetic-rejected-exa-key')
  })

  it('rejects invalid seeds and options at build, and invalid seeds on seed()', async () => {
    const result = { url: 'https://linkedin.example.com/in/a' }

    // Parsed from JSON, as a host passing untyped input would.
    const cases: ReadonlyArray<{
      readonly reason: string
      readonly options: LinkedInSearchEmulatorOptions
    }> = JSON.parse(
      JSON.stringify([
        { reason: 'unexpected key at the seed root', options: { seed: { extra: true } } },
        {
          reason: 'duplicate search at searches[1]',
          options: {
            seed: {
              searches: [
                { query: 'q', numResults: 1, results: [result] },
                { query: 'q', numResults: 1, results: [result] }
              ]
            }
          }
        },
        {
          reason: 'not 1 to numResults results at searches[0].results',
          options: { seed: { searches: [{ query: 'q', numResults: 1, results: [] }] } }
        },
        {
          reason: 'not 1 to numResults results at searches[0].results',
          options: {
            seed: { searches: [{ query: 'q', numResults: 1, results: [result, result] }] }
          }
        },
        {
          reason: 'invalid value at searches[0].numResults',
          options: { seed: { searches: [{ query: 'q', numResults: 101, results: [result] }] } }
        },
        {
          reason: 'invalid value at searches[0].query',
          options: { seed: { searches: [{ query: ' q', numResults: 1, results: [result] }] } }
        },
        {
          reason: 'missing key at searches[0].numResults',
          options: { seed: { searches: [{ query: 'q', results: [result] }] } }
        },
        {
          reason: 'invalid type at searches[0].results[0].url',
          options: { seed: { searches: [{ query: 'q', numResults: 1, results: [{ url: null }] }] } }
        },
        {
          reason: 'invalid value at absentProfileUrls[0]',
          options: { seed: { absentProfileUrls: ['https://x.example/a'] } }
        },
        {
          reason: 'duplicate profile URL at absentProfileUrls[0]',
          options: { seed: { absentProfileUrls: [seeds.profileUrl] } }
        },
        {
          reason: 'not a recognisable bearer value at exaRejectedKeys[0]',
          options: { seed: { exaRejectedKeys: ['0123456789abcdef'] } }
        },
        {
          reason: 'not a recognisable bearer value at enrichLayerRejectedKeys[0]',
          options: { seed: { enrichLayerRejectedKeys: ['short'] } }
        },
        {
          reason: 'duplicate key at exaRejectedKeys[1]',
          options: { seed: { exaRejectedKeys: ['synthetic-key-a', 'synthetic-key-a'] } }
        },
        {
          reason: 'invalid type at enrichLayerRejectedKeys',
          options: { seed: { enrichLayerRejectedKeys: 'synthetic-key-a' } }
        },
        { reason: 'invalid type at the seed root', options: { seed: 'synthetic-key-a' } },
        { reason: 'unknown drill knob nope', options: { drills: { nope: true } } },
        { reason: 'must be a boolean', options: { drills: { numResultsIgnored: 'yes' } } }
      ])
    )

    const target = await emulator()
    const before = target.snapshot()

    for (const { reason, options } of cases) {
      await expect(makeLinkedInSearchEmulator(options), reason).rejects.toThrow(
        options.seed === undefined ? reason : `Invalid LinkedIn search emulator seed: ${reason}`
      )

      if (options.seed !== undefined) {
        await expect(target.seed(options.seed), reason).rejects.toBeInstanceOf(
          LinkedInSearchEmulatorInputInvalid
        )
        expect(target.snapshot()).toEqual(before)
      }
    }
  })

  // Seed errors are constant text (a category and a field path): no key or other seeded value,
  // whichever field carries it (a misspelled field, a duplicate search, a bad value, a made-up
  // key).
  const secretKey = 'synthetic-secret-key-01'

  const duplicateSearch = {
    query: secretKey,
    numResults: 1,
    results: [{ url: 'https://linkedin.example.com/in/a' }]
  }

  const seedErrorRows = (field: 'exaRejectedKeys' | 'enrichLayerRejectedKeys') =>
    [
      [
        'a duplicate search whose query is the key',
        { [field]: [secretKey], searches: [duplicateSearch, duplicateSearch] },
        'duplicate search at searches[1]'
      ],
      [
        'the key under a misspelled field',
        { [field.slice(0, -1)]: [secretKey] },
        'unexpected key at the seed root'
      ],
      [
        'the key under rejectedKeys',
        { rejectedKeys: [secretKey] },
        'unexpected key at the seed root'
      ],
      ['the key as a made-up field name', { [secretKey]: 1 }, 'unexpected key at the seed root'],
      [
        'the key as a made-up result field',
        {
          [field]: [secretKey],
          searches: [{ ...duplicateSearch, results: [{ [secretKey]: 'x' }] }]
        },
        'unexpected key at searches[0].results[0]'
      ],
      ['a bad value beside the key', { [field]: [secretKey, 7] }, `invalid type at ${field}[1]`],
      ['the key as a bare string', { [field]: secretKey }, `invalid type at ${field}`],
      ['the key duplicated', { [field]: [secretKey, secretKey] }, `duplicate key at ${field}[1]`]
    ] as const

  for (const field of ['exaRejectedKeys', 'enrichLayerRejectedKeys'] as const) {
    it.each(seedErrorRows(field))(`${field}: %s`, async (_label, seed, reason) => {
      // Parsed from JSON, as a host passing untyped input would.
      const options: LinkedInSearchEmulatorOptions = { seed: JSON.parse(JSON.stringify(seed)) }

      const thrown = await makeLinkedInSearchEmulator(options).then(
        () => undefined,
        (error: unknown) => error
      )

      expect(thrown).toBeInstanceOf(LinkedInSearchEmulatorInputInvalid)
      expect(String(thrown instanceof Error ? thrown.message : thrown)).toBe(
        `Invalid LinkedIn search emulator seed: ${reason}`
      )

      const target = await emulator()
      const before = target.snapshot()

      const answered = await target.fetch(
        new Request(`${exa}/_emulate/seed`, { method: 'POST', body: JSON.stringify(seed) })
      )

      const text = await answered.text()

      expect(answered.status).toBe(400)
      expect(JSON.parse(text)).toEqual({
        error: { message: `invalid seed: ${reason}`, type: 'emulator_error' }
      })
      expect(target.snapshot()).toEqual(before)

      const seen = [String(thrown), text, ...(await controlReads(target))].join('\n')

      expect(seen).not.toContain(secretKey)
      expect(seen).not.toContain('secret-key')
    })
  }
})

describe('control plane', () => {
  it('serves the ledger, faults, state, seed, reset, and coverage', async () => {
    const target = await emulator()

    const control = (method: string, path: string, body?: unknown) =>
      target.fetch(
        new Request(`${exa}/_emulate/${path}`, {
          method,
          body: body === undefined ? undefined : JSON.stringify(body)
        })
      )

    await validRequest(target)
    await call(target, 'GET', profileUrl())
    await call(target, 'GET', `${exa}/nope`)

    const coverage: unknown = await (await control('GET', 'coverage')).json()

    expect(coverage).toMatchObject({ unknownRouteRequests: 1, notEmulatedRequests: 1 })
    expect(
      target
        .coverage()
        .routes.filter(route => route.requests > 0)
        .map(route => `${route.method} ${route.path}`)
    ).toEqual(['POST /search', 'GET /api/v2/profile'])

    const state: unknown = await (await control('GET', 'state')).json()

    expect(state).toMatchObject({
      state: { absentProfileUrls: [seeds.absentProfileUrl] },
      ledgerEntries: 3
    })

    expect((await control('POST', 'faults', { kind: 'status', status: 500 })).status).toBe(201)
    expect((await control('POST', 'faults', { kind: 'status', status: 204 })).status).toBe(400)
    expect(await (await control('GET', 'faults')).json()).toMatchObject({ faults: [{ id: 1 }] })
    expect(await (await control('DELETE', 'faults')).json()).toEqual({ cleared: 1 })

    expect(await (await control('POST', 'reset')).json()).toEqual({ reset: true })
    expect(target.ledger.entries()).toEqual([])

    const seeded = await control('POST', 'seed', {
      profiles: [],
      exaRejectedKeys: ['synthetic-control-key']
    })

    const seededText = await seeded.text()

    expect(JSON.parse(seededText)).toEqual({
      seeded: true,
      searches: 3,
      profiles: 0,
      absentProfiles: 1,
      exaRejectedKeys: 1,
      enrichLayerRejectedKeys: 1
    })
    expect(seededText).not.toContain('synthetic-control-key')
    expect((await control('POST', 'seed', { profiles: 'nope' })).status).toBe(400)

    const refused = await control('POST', 'seed', { exaRejectedKeys: ['0123456789abcdef'] })

    expect(refused.status).toBe(400)
    expect(await refused.text()).not.toContain('0123456789abcdef')

    await target.reset()
    expect(target.snapshot().profiles).toEqual([])
    expect(JSON.stringify(await controlReads(target))).not.toContain('synthetic-control-key')

    expect((await control('PUT', 'reset')).status).toBe(405)
    expect((await control('GET', 'nope')).status).toBe(404)
    expect(await (await control('DELETE', 'ledger')).json()).toEqual({ cleared: 0 })
    // Control-plane requests are never ledgered.
    expect(target.ledger.entries()).toEqual([])
  })
})
