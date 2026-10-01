import { describe, expect, it } from '@effect/vitest'
import { Effect, Layer, Option, Predicate, Ref } from 'effect'
import * as Schema from 'effect/Schema'
import { TestClock } from 'effect/testing'
import { HttpClient, HttpClientError, type HttpClientRequest } from 'effect/unstable/http'
import type { ConformanceCase } from '@yolk-sdk/conformance/case'
import {
  decodeWireFixture,
  isWireBase64BodyResponse,
  isWireStreamResponse,
  scanFixtureForSecrets,
  type WireExchange,
  type WireFixture,
  type WireResponse
} from '@yolk-sdk/conformance/fixture'
import {
  makeReplayHttpClient,
  ReplayHttpClient,
  type ReplayLedgerApi
} from '@yolk-sdk/conformance/replay'
import {
  conformanceReportFailed,
  formatConformanceReport,
  runConformance,
  type ConformanceTarget
} from '@yolk-sdk/conformance/runner'
import { ApiKeyCredential, ConnectorHttpClient } from '@yolk-sdk/connectors'
import {
  connectorHttpClientsFromEffectHttpClientLayer,
  staticCredentialResolverLayer
} from '@yolk-sdk/connectors/conformance'
import {
  LinkedInSearchConnector,
  LinkedInSearchInput,
  enrichLayerApiKeySlotId,
  exaApiKeySlotId,
  linkedInSearchAction
} from '@yolk-sdk/connectors/linkedin-search'
import {
  LinkedInSearchConformanceConfig,
  LinkedInSearchConformanceSeeds as LinkedInSearchConformanceSeedsSchema,
  linkedInSearchConformanceCases,
  linkedInSearchConformanceCredentials,
  linkedInSearchConformanceFixtureSeeds,
  linkedInSearchConformanceFixtures,
  linkedInSearchConformanceIntegration,
  linkedInSearchEmailLookupFixture,
  linkedInSearchEnrichLayerUnauthorizedFixture,
  linkedInSearchExaUnauthorizedFixture,
  linkedInSearchNumResultsLimitFixture,
  linkedInSearchPeopleResultsFixture,
  linkedInSearchProfileFixture,
  linkedInSearchProfileNotFoundFixture,
  type LinkedInSearchConformanceCase,
  type LinkedInSearchConformanceSeeds
} from '@yolk-sdk/connectors/linkedin-search/conformance'

const now = new Date('2026-10-01T12:00:00.000Z')

const atTestNow = TestClock.setTime(now.getTime())

const syntheticExaKey = 'exa-synthetic-replay-key-0001'

const syntheticEnrichLayerKey = 'enrich-layer-synthetic-replay-key-0001'

const credentialLayer = staticCredentialResolverLayer(
  linkedInSearchConformanceCredentials({
    exaApiKey: syntheticExaKey,
    enrichLayerApiKey: syntheticEnrichLayerKey
  })
)

const portsOver = (
  httpLayer: Layer.Layer<HttpClient.HttpClient>,
  seeds: LinkedInSearchConformanceSeeds = linkedInSearchConformanceFixtureSeeds
) =>
  Layer.mergeAll(
    connectorHttpClientsFromEffectHttpClientLayer.pipe(Layer.provide(httpLayer)),
    credentialLayer,
    Layer.succeed(LinkedInSearchConformanceConfig, seeds)
  )

const fixturesFor = (
  testCase: Pick<ConformanceCase<unknown, unknown>, 'fixtures'>,
  fixtures: ReadonlyArray<WireFixture> = linkedInSearchConformanceFixtures
) => fixtures.filter(fixture => testCase.fixtures.includes(fixture.id))

const replayLayerOver =
  (
    fixtures: ReadonlyArray<WireFixture> = linkedInSearchConformanceFixtures,
    seeds: LinkedInSearchConformanceSeeds = linkedInSearchConformanceFixtureSeeds
  ) =>
  (testCase: LinkedInSearchConformanceCase) =>
    portsOver(ReplayHttpClient.layer(fixturesFor(testCase, fixtures)), seeds)

const ledgerCaseLayer =
  (
    ledgers: Ref.Ref<Map<string, ReplayLedgerApi>>,
    fixtures: ReadonlyArray<WireFixture> = linkedInSearchConformanceFixtures,
    seeds: LinkedInSearchConformanceSeeds = linkedInSearchConformanceFixtureSeeds
  ) =>
  (testCase: LinkedInSearchConformanceCase) =>
    portsOver(
      Layer.unwrap(
        makeReplayHttpClient(fixturesFor(testCase, fixtures)).pipe(
          Effect.tap(({ ledger }) =>
            Ref.update(ledgers, current => new Map(current).set(testCase.id, ledger))
          ),
          Effect.map(({ client }) => Layer.succeed(HttpClient.HttpClient, client))
        )
      ),
      seeds
    )

const ledgerOf = (ledgers: Ref.Ref<Map<string, ReplayLedgerApi>>, caseId: string) =>
  Effect.gen(function* () {
    const ledger = (yield* Ref.get(ledgers)).get(caseId)

    if (ledger === undefined) {
      return expect.fail(`no ledger for ${caseId}`)
    }

    return { entries: yield* ledger.entries, remaining: yield* ledger.remaining }
  })

const synthetic = (id: string) => `${id}.synthetic`

const caseIds = [
  'linkedin-search.search.people-results',
  'linkedin-search.search.num-results-limit',
  'linkedin-search.profile.get-profile',
  'linkedin-search.email.lookup-answer',
  'linkedin-search.errors.exa-unauthorized',
  'linkedin-search.errors.enrich-layer-unauthorized',
  'linkedin-search.errors.profile-not-found'
] as const

function textBody(response: WireResponse): string {
  if (isWireStreamResponse(response) || isWireBase64BodyResponse(response)) {
    return expect.fail('expected a text body')
  }

  return response.body
}

// The synthetic-data allowlist. Every committed 2xx body, request query, and seed must pass it, so
// a promoted recording that was scrubbed field by field instead of replaced wholesale fails. What
// it enforces, exactly:
// - Characters: every string and every key is printable ASCII (U+0020 to U+007E) only; any other
//   character (another script, full-width digits, control or zero-width characters) is refused,
//   never discarded. URL paths, queries, and fragments are also checked after percent-decoding.
// - Timestamps: a string that is wholly one ISO timestamp (`20YY-MM-DDThh:mm:ss[.fff]Z`, at most
//   3 fraction digits) passes; a timestamp inside other text is ordinary text, and no bare date
//   ever passes.
// - Words: every other string is split on ASCII non-alphanumerics, and every word must be in
//   `syntheticVocabulary` (compared lower-case) or be digits; a string holds at most 2 digits in
//   all (a synthetic sequence number such as `01`), so phone numbers in short groups and dates
//   fail.
// - URLs: no username or password, no `.` or `..` path segment and no backslash (encoded forms
//   included, since parsing would hide them); the host is an example domain (`example.com`, `example.test`)
//   whose subdomain labels pass the word check, or one of the two provider API origins; the path,
//   query, and fragment pass the word check (together, with one digit budget).
// - Emails: a whole string only; the domain is an example domain whose subdomain labels pass the
//   word check, and the local part passes the word check. An `@` anywhere else (a display-name
//   address such as `Name <a@b.co>`) is refused. `linkedin` is allowed only as the
//   `linkedin.example.com` host label, never as a word.
// - Keys: only those in `allowedKeys` (what the committed fixtures hold and the cases decode); a
//   refused key is reported and its value is not inspected.
// - Non-strings: refused, except top-level `totalResults` and `email_queue_count` (numbers) and
//   `email` (null), the only non-string values the cases decode.
// - `status`: only at the top level of the email answer, and only one of `emailStatuses`; anywhere
//   else it is an ordinary string.

/** Every word a committed fixture or seed may hold; keep it short and explicit. */
const syntheticVocabulary = new Set([
  'synthetic',
  'person',
  'example',
  'co',
  'labs',
  'conformance',
  'engineer',
  'test',
  'lead',
  'at',
  'profile',
  'text',
  'not',
  'a',
  'real',
  // `/in/...` profile URL paths and the absent-profile seed (`linkedin` is allowed only as the
  // `linkedin.example.com` host label, never as a word).
  'in',
  'absent',
  // The unauthorized search's fixed query (`yolk-conformance unauthorized probe`).
  'yolk',
  'unauthorized',
  'probe'
])

/** Every key a committed 2xx body may hold: what the fixtures hold and the cases decode. */
const allowedKeys = new Set([
  // Exa search answers.
  'results',
  'title',
  'url',
  'text',
  'publishedDate',
  'author',
  'totalResults',
  // The Enrich Layer profile fixture (the case reads only that it is a non-empty object).
  'public_identifier',
  'full_name',
  'headline',
  // The Enrich Layer email answer.
  'email',
  'status',
  'message',
  'email_queue_count'
])

/** A full ISO timestamp, allowed only as a WHOLE string (never inside text); no bare date. */
const isoTimestamp = /^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/

/** The most digits one string may hold. */
const maxDigits = 2

/** The statuses the connector knows, the only `status` values the email answer may carry. */
const emailStatuses = new Set(['found', 'not_found', 'queued', 'unknown'])

/** The only non-string leaves a 2xx body may hold: top-level keys the cases decode. */
const decodedNonStrings = new Map<string, (value: unknown) => boolean>([
  ['totalResults', Predicate.isNumber],
  ['email_queue_count', Predicate.isNumber],
  ['email', Predicate.isNull]
])

const isPrintableAscii = (text: string): boolean => /^[\x20-\x7e]*$/.test(text)

/** Percent escapes decoded byte by byte (never throws), so encoded non-ASCII bytes show up. */
const percentDecoded = (text: string): string =>
  text.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  )

/** True when `text` passes the character, word, and digit checks. */
const isVocabularyText = (text: string): boolean => {
  if (!isPrintableAscii(text)) return false

  if (isoTimestamp.test(text)) return true

  return (
    (text.match(/\d/g) ?? []).length <= maxDigits &&
    text
      .split(/[^A-Za-z0-9]+/)
      .filter(word => word.length > 0)
      .every(word => /^\d+$/.test(word) || syntheticVocabulary.has(word.toLowerCase()))
  )
}

/** An example domain whose subdomain labels (the part before `example.*`) pass the word check. */
const isExampleHost = (host: string): boolean => {
  const match = /^(?:(.+)\.)?example\.(?:com|test)$/.exec(host)

  return match !== null && (match[1] === 'linkedin' || isVocabularyText(match[1] ?? ''))
}

/** No user info; an example host or a provider origin; a vocabulary-only path, query, fragment. */
const isSyntheticUrl = (text: string): boolean => {
  // URL parsing removes dot segments (`/jane-roe/../`) and turns `\` into `/`, hiding what the
  // committed string holds: refuse both, encoded forms included, before parsing.
  if (/(?:^|[/\\])\.{1,2}(?:[/\\?#]|$)|\\/.test(percentDecoded(text))) return false

  const url = URL.parse(text)

  if (url === null || url.username !== '' || url.password !== '') return false

  const host =
    isExampleHost(url.hostname) ||
    ['https://api.exa.ai', 'https://enrichlayer.com'].includes(url.origin)

  return host && isVocabularyText(percentDecoded(`${url.pathname} ${url.search} ${url.hash}`))
}

/** A string the allowlist accepts: a synthetic URL, a synthetic email, or vocabulary text. */
const isSyntheticString = (text: string): boolean => {
  if (!isPrintableAscii(text)) return false

  if (/^https?:\/\//.test(text)) return isSyntheticUrl(text)

  const email = /^([^\s@]+)@([^\s@]+)$/.exec(text)

  if (email !== null) {
    return isExampleHost(email[2] ?? '') && isVocabularyText(email[1] ?? '')
  }

  // An `@` anywhere else (a display-name address such as `Name <a@b.co>`) is never synthetic.
  return !text.includes('@') && isVocabularyText(text)
}

/**
 * `key: value` for every leaf of a 2xx body the allowlist refuses, and `key: key not allowlisted`
 * for every refused key (see the comment above); `emailAnswer` exempts a top-level `status` among
 * `emailStatuses`.
 */
const notObviouslySynthetic = (
  value: unknown,
  options: { readonly emailAnswer: boolean },
  key = ''
): ReadonlyArray<string> => {
  const label = `${key}: ${JSON.stringify(value)}`

  if (Predicate.isString(value)) {
    if (options.emailAnswer && key === 'status') return emailStatuses.has(value) ? [] : [label]

    return isSyntheticString(value) ? [] : [label]
  }

  if (Array.isArray(value)) return value.flatMap(item => notObviouslySynthetic(item, options, key))

  if (Predicate.isObject(value)) {
    return Object.entries(value).flatMap(([child, item]) => {
      const path = key.length === 0 ? child : `${key}.${child}`

      return isPrintableAscii(child) && allowedKeys.has(child)
        ? notObviouslySynthetic(item, options, path)
        : [`${path}: key not allowlisted`]
    })
  }

  return decodedNonStrings.get(key)?.(value) === true ? [] : [label]
}

/** The `query` of a request body, when it has one. */
const requestQuery = (body: unknown): string | undefined =>
  Predicate.hasProperty(body, 'query') && Predicate.isString(body.query) ? body.query : undefined

describe('LinkedIn search conformance cases', () => {
  it('are all reads, stay unverified, and are backed by one fixture each', () => {
    expect(linkedInSearchConformanceCases.map(testCase => testCase.id)).toEqual(caseIds)
    expect(linkedInSearchConformanceCases.map(testCase => testCase.safety)).toEqual(
      caseIds.map(() => 'read')
    )
    expect(linkedInSearchConformanceFixtures.map(fixture => fixture.caseId)).toEqual(caseIds)

    for (const testCase of linkedInSearchConformanceCases) {
      expect(testCase.observed).toBeUndefined()
      expect(testCase.fixtures).toEqual([synthetic(testCase.id)])
    }
  })

  it('cite only real connector actions', () => {
    const actionIds = new Set(LinkedInSearchConnector.actions.map(action => action.id))

    for (const testCase of linkedInSearchConformanceCases) {
      const cited = [
        ...`${testCase.docs} ${testCase.wire}`.matchAll(/`(linkedin_search\.[a-z_]+)`/g)
      ].map(match => match[1])

      expect(cited.length).toBeGreaterThan(0)
      expect(cited.filter(id => id === undefined || !actionIds.has(id))).toEqual([])
    }
  })

  it('mark every guessed sub-claim unverified in wire', () => {
    expect(
      linkedInSearchConformanceCases.flatMap(testCase =>
        [...testCase.wire.matchAll(/\bunverified: /g)].map(() => testCase.id)
      )
    ).toEqual([
      'linkedin-search.search.people-results',
      'linkedin-search.search.people-results',
      'linkedin-search.profile.get-profile',
      'linkedin-search.email.lookup-answer',
      'linkedin-search.errors.exa-unauthorized',
      'linkedin-search.errors.enrich-layer-unauthorized',
      'linkedin-search.errors.profile-not-found'
    ])
  })

  it.effect('ship synthetic fixtures that decode and pass the secret scan', () =>
    Effect.gen(function* () {
      for (const fixture of linkedInSearchConformanceFixtures) {
        expect(yield* decodeWireFixture(fixture)).toEqual(fixture)
        expect(scanFixtureForSecrets(fixture)).toEqual([])
        expect(fixture).toMatchObject({ evidence: 'unverified', account: 'synthetic' })
        expect(['https://api.exa.ai', 'https://enrichlayer.com/api/v2']).toContain(fixture.endpoint)

        for (const { request } of fixture.exchanges) {
          expect(Object.keys(request.headers ?? {})).not.toContain('authorization')
          expect(request.url.startsWith(`${fixture.endpoint}/`)).toBe(true)
          expect(JSON.stringify(request)).not.toContain(syntheticExaKey)
          expect(JSON.stringify(request)).not.toContain(syntheticEnrichLayerKey)
        }
      }
    })
  )

  it('carry only allowlisted synthetic data in 2xx bodies, request queries, and seeds', () => {
    const bodies = linkedInSearchConformanceFixtures.flatMap(fixture =>
      fixture.exchanges.flatMap(({ response }) =>
        response.status < 300
          ? [{ caseId: fixture.caseId, body: JSON.parse(textBody(response)) }]
          : []
      )
    )

    expect(bodies).toHaveLength(5)

    for (const { caseId, body } of bodies) {
      expect(
        notObviouslySynthetic(body, {
          emailAnswer: caseId === 'linkedin-search.email.lookup-answer'
        })
      ).toEqual([])
    }

    for (const fixture of linkedInSearchConformanceFixtures) {
      for (const { request } of fixture.exchanges) {
        const url = new URL(request.url)

        expect(['https://api.exa.ai', 'https://enrichlayer.com']).toContain(url.origin)

        // Query parameter values (the seeded profile URL) and the search query.
        for (const value of [...url.searchParams.values(), requestQuery(request.body)]) {
          if (value !== undefined) expect([value, isSyntheticString(value)]).toEqual([value, true])
        }
      }
    }

    for (const seed of Object.values(linkedInSearchConformanceFixtureSeeds)) {
      expect([seed, isSyntheticString(seed)]).toEqual([seed, true])
    }
  })

  it('the allowlist accepts what the cases decode', () => {
    for (const body of [
      { email: null },
      { email_queue_count: 3 },
      { email: 'synthetic-person-01@example.com', status: 'found' },
      { email: null, status: 'not_found' }
    ]) {
      expect(notObviouslySynthetic(body, { emailAnswer: true })).toEqual([])
    }

    expect(
      notObviouslySynthetic(
        {
          totalResults: 3,
          results: [
            {
              title: 'Synthetic Person 02 | Test Lead at Example Synthetic Labs',
              url: 'https://linkedin.example.com/in/synthetic-person-02',
              publishedDate: '2026-01-15T00:00:00.000Z'
            }
          ]
        },
        { emailAnswer: false }
      )
    ).toEqual([])
  })

  it('the allowlist refuses strings a field-by-field scrub would leave', () => {
    for (const value of [
      // Partial scrubs and real names, companies, and queries.
      'Synthetic Person 01; colleague Jordan Rivers, phone +1 555 0100',
      'Head of Synthetic Biology at Ginkgo Bioworks',
      'Jane Roe (Synthetic)',
      'Jane Roe',
      'synthetic conformance engineer at Acme Robotics',
      // Other scripts and characters outside printable ASCII: refused, never discarded.
      '山田太郎',
      'Анна Иванова, Москва',
      'محمد أحمد',
      'Synthetic Person 01. 東京大学卒、山田太郎と共同',
      '李明',
      '０９０ １２３４ ５６７８',
      'Synthetic\u200bPerson',
      'Synthetic\tPerson',
      // Phone numbers in short groups, and dates (no bare date, no 19YY timestamp).
      '+33 6 12 34 56 78',
      '06 12 34 56 78',
      'Synthetic Person 01, +33 6 12 34 56 78',
      '1987-03-14',
      '14/03/87',
      '2026-01-15',
      '1987-03-14T00:00:00.000Z',
      // URLs: real paths, other hosts, user info, real subdomains, non-ASCII paths.
      'https://linkedin.example.com/company/acme-robotics',
      'https://linkedin.example.com/school/real-university',
      'https://linkedin.example.com/in/jane-roe',
      'https://enrichlayer.com/api/v2/profile?name=jane-roe',
      'https://www.linkedin.com/in/jr',
      'https://media.example.net/pic.jpg',
      'https://linkedin.example.com/in/李明',
      'https://linkedin.example.com/in/%E6%9D%8E%E6%98%8E',
      'https://jane.roe@linkedin.example.com/in/synthetic-person-01',
      'https://jane:secret@linkedin.example.com/in/synthetic-person-01',
      'https://jane-roe.example.com/in/synthetic-person-01',
      // Emails off the example domains, or with a real local part or subdomain.
      'synthetic-person-01@gmail.com',
      'jordan.rivers@example.com',
      'synthetic-person-01@jane-roe.example.com',
      // A display-name address, a real company named by an allowed host label, dot segments
      // hiding a name, and dates or digits hidden inside timestamps.
      'Engineer <a.person@real.co>',
      'Synthetic Person <synthetic-person-01@example.com>',
      'Engineer at LinkedIn',
      'linkedin',
      'https://linkedin.example.com/in/jane-roe/../synthetic-person-01',
      'https://linkedin.example.com/in/jane-roe/%2E%2E/synthetic-person-01',
      'https://linkedin.example.com/in/./synthetic-person-01',
      'https://linkedin.example.com\\in\\synthetic-person-01',
      'Synthetic Person 01 2004-07-09T00:00:00Z',
      'https://linkedin.example.com/in/2003-03-14T00:00:00Z',
      '2026-01-15T00:00:00.33612345678Z'
    ]) {
      expect([value, isSyntheticString(value)]).toEqual([value, false])
    }
  })

  it('the allowlist refuses keys, non-strings, and statuses outside what the cases decode', () => {
    for (const [body, emailAnswer, refused] of [
      [{ 'Jane Roe': [] }, false, ['Jane Roe: key not allowlisted']],
      [
        { results: [{ extras: { 'jane.roe@gmail.com': 'Synthetic' } }] },
        false,
        ['results.extras: key not allowlisted']
      ],
      [{ 山田: 'Synthetic' }, false, ['山田: key not allowlisted']],
      [
        { birth_date: { day: 14, month: 3, year: 1987 } },
        false,
        ['birth_date: key not allowlisted']
      ],
      [{ phone: 15550100 }, false, ['phone: key not allowlisted']],
      [{ results: [{ title: 15550100 }] }, false, ['results.title: 15550100']],
      [{ results: [{ totalResults: 3 }] }, false, ['results.totalResults: 3']],
      [{ results: [{ status: 'Jane Roe' }] }, false, ['results.status: "Jane Roe"']],
      [{ status: 'jordan.rivers@gmail.com' }, true, ['status: "jordan.rivers@gmail.com"']],
      // A top-level `status` outside the email answer is an ordinary string.
      [{ status: 'found' }, false, ['status: "found"']]
    ] as const) {
      expect(notObviouslySynthetic(body, { emailAnswer })).toEqual(refused)
    }
  })

  it.effect('all pass on replay with unverified warnings', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const report = yield* runConformance(linkedInSearchConformanceCases, {
        target: { kind: 'replay' },
        now,
        fixtures: linkedInSearchConformanceFixtures,
        layer: replayLayerOver()
      })

      expect(report.summary).toEqual({ passed: 7, failed: 0, skipped: 0 })
      expect(conformanceReportFailed(report)).toBe(false)

      for (const result of report.results) {
        expect(result.warnings).toEqual([
          { kind: 'unverified-case' },
          { kind: 'unverified-fixture', fixtureId: synthetic(result.id) }
        ])
      }

      const formatted = formatConformanceReport(report)

      expect(formatted).not.toContain(syntheticExaKey)
      expect(formatted).not.toContain(syntheticEnrichLayerKey)
    })
  )

  it.effect('consume every recorded exchange in order and send the recorded requests', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

      const report = yield* runConformance(linkedInSearchConformanceCases, {
        target: { kind: 'replay' },
        now,
        layer: ledgerCaseLayer(ledgers)
      })

      expect(report.summary.passed).toBe(7)

      for (const testCase of linkedInSearchConformanceCases) {
        const { entries, remaining } = yield* ledgerOf(ledgers, testCase.id)
        const [fixture] = fixturesFor(testCase)

        if (fixture === undefined) {
          return expect.fail(`no fixture for ${testCase.id}`)
        }

        expect(remaining).toEqual([])
        expect(entries).toHaveLength(fixture.exchanges.length)

        entries.forEach((entry, index) => {
          const exchange: WireExchange | undefined = fixture.exchanges[index]

          expect(entry.match).toEqual({
            outcome: 'matched',
            fixtureId: fixture.id,
            exchangeIndex: index
          })
          expect(entry.bodyJson ?? entry.bodyText).toEqual(exchange?.request.body)
          expect(entry.headers).toMatchObject(exchange?.request.headers ?? {})
        })
      }
    })
  )

  it.effect('send each provider its own key as a bearer token, never the other one', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const sent = yield* Ref.make<ReadonlyArray<string>>([])

      const recordingAuthorization = (testCase: LinkedInSearchConformanceCase) =>
        Layer.effect(
          ConnectorHttpClient,
          Effect.gen(function* () {
            const inner = yield* ConnectorHttpClient

            return ConnectorHttpClient.of({
              request: request =>
                Ref.update(sent, list => [
                  ...list,
                  `${new URL(request.url).host} ${request.headers?.authorization ?? 'none'}`
                ]).pipe(Effect.andThen(inner.request(request)))
            })
          })
        ).pipe(Layer.provideMerge(replayLayerOver()(testCase)))

      const report = yield* runConformance(
        linkedInSearchConformanceCases.filter(testCase =>
          [
            'linkedin-search.search.people-results',
            'linkedin-search.profile.get-profile',
            'linkedin-search.email.lookup-answer'
          ].includes(testCase.id)
        ),
        { target: { kind: 'replay' }, now, layer: recordingAuthorization }
      )

      expect(report.summary.passed).toBe(3)
      expect(yield* Ref.get(sent)).toEqual([
        `api.exa.ai Bearer ${syntheticExaKey}`,
        `enrichlayer.com Bearer ${syntheticEnrichLayerKey}`,
        `enrichlayer.com Bearer ${syntheticEnrichLayerKey}`
      ])
    })
  )

  it('bind each key to its own slot', () => {
    expect(
      linkedInSearchConformanceCredentials({ exaApiKey: 'exa', enrichLayerApiKey: 'enrich' })
    ).toEqual({
      [exaApiKeySlotId]: ApiKeyCredential.make({ key: 'exa' }),
      [enrichLayerApiKeySlotId]: ApiKeyCredential.make({ key: 'enrich' })
    })
    expect(
      linkedInSearchConformanceIntegration().credentialBindings.map(binding => binding.slotId)
    ).toEqual([exaApiKeySlotId, enrichLayerApiKeySlotId])
  })

  it('accept seeds of the documented shapes only', () => {
    const decode = Schema.decodeUnknownOption(LinkedInSearchConformanceSeedsSchema)

    expect(Option.isSome(decode(linkedInSearchConformanceFixtureSeeds))).toBe(true)
    expect(Option.isSome(decode({ profileUrl: 'https://www.linkedin.example.com/in/a-b/' }))).toBe(
      true
    )

    for (const invalid of [
      { searchQuery: ' padded ' },
      { searchQuery: 'two\nlines' },
      { profileUrl: 'http://linkedin.example.com/in/synthetic-person-01' },
      { profileUrl: 'https://linkedin.example.com/company/example-synthetic-co' },
      { profileUrl: 'https://linkedin.example.com/in/synthetic-person-01?trk=x' },
      { absentProfileUrl: 'not a url' }
    ]) {
      expect(Option.isNone(decode(invalid))).toBe(true)
    }
  })
})

describe('LinkedIn search conformance safety on a live target', () => {
  const statuses = (target: ConformanceTarget) =>
    atTestNow.pipe(
      Effect.andThen(
        runConformance(linkedInSearchConformanceCases, { target, now, layer: replayLayerOver() })
      ),
      Effect.map(report => report.results.map(result => [result.id, result.status]))
    )

  it.effect('runs every case by default: all are reads, none needs a write opt-in', () =>
    Effect.gen(function* () {
      const expected = caseIds.map(id => [id, 'passed'])

      expect(yield* statuses({ kind: 'live', account: 'synthetic' })).toEqual(expected)
      expect(
        yield* statuses({ kind: 'live', account: 'synthetic', allowWrites: 'reversible' })
      ).toEqual(expected)
    })
  )
})

// Drills: replay a fixture that contradicts a claim, or drop it, and check that exactly that case
// fails.

const replaceResponse = (
  fixture: WireFixture,
  index: number,
  response: (original: WireResponse) => WireResponse
): WireFixture => {
  const swap = (exchange: WireExchange, position: number): WireExchange =>
    position === index ? { ...exchange, response: response(exchange.response) } : exchange

  const [first, ...rest] = fixture.exchanges

  return {
    ...fixture,
    exchanges: [swap(first, 0), ...rest.map((exchange, offset) => swap(exchange, offset + 1))]
  }
}

const withStatus =
  (status: number, body: string) =>
  (response: WireResponse): WireResponse => ({ status, headers: response.headers, body })

const mismatch = (message: string) => ({ kind: 'failure', tag: 'ConformanceMismatch', message })

const suiteFailures = (
  fixtures: ReadonlyArray<WireFixture>,
  seeds: LinkedInSearchConformanceSeeds = linkedInSearchConformanceFixtureSeeds
) =>
  Effect.gen(function* () {
    yield* atTestNow

    const report = yield* runConformance(linkedInSearchConformanceCases, {
      target: { kind: 'replay' },
      now,
      layer: replayLayerOver(fixtures, seeds)
    })

    return report.results
      .filter(result => result.status === 'failed')
      .map(result => ({ id: result.id, failure: result.failure }))
  })

const withReplaced = (...tampered: ReadonlyArray<WireFixture>) =>
  linkedInSearchConformanceFixtures.map(
    fixture => tampered.find(candidate => candidate.id === fixture.id) ?? fixture
  )

/** An Exa result as a drill writes it: `null` where a real answer might send one. */
type DrillResult = {
  readonly id?: string
  readonly title?: string | null
  readonly url?: string | null
  readonly author?: string | null
  readonly text?: string
  readonly publishedDate?: string | null
}

/** A synthetic person result, with every field the connector decodes. */
const person = (number: string): DrillResult => ({
  id: `https://linkedin.example.com/in/synthetic-person-${number}`,
  title: `Synthetic Person ${number} | Conformance Engineer at Example Synthetic Co`,
  url: `https://linkedin.example.com/in/synthetic-person-${number}`,
  author: `Synthetic Person ${number}`,
  publishedDate: '2026-01-15T00:00:00.000Z',
  text: `Synthetic Person ${number}. Synthetic profile text, not a real person.`
})

const people = (count: number): ReadonlyArray<DrillResult> =>
  Array.from({ length: count }, (_, index) => person(String(index + 1).padStart(2, '0')))

/** A 2xx Exa answer carrying `results`. */
const withResults = (results: ReadonlyArray<DrillResult>) =>
  withStatus(200, JSON.stringify({ requestId: 'synthetic-request-0009', results }))

const searchDecodeFailure = (paths: string) =>
  mismatch(
    `expected the 2xx answer of linkedin_search.search to decode as the connector reads it; null where it reads a string or number: ${paths}`
  )

const tampers: ReadonlyArray<{
  readonly fixture: WireFixture
  readonly failure: ReturnType<typeof mismatch>
}> = [
  {
    // Exa answering null for a missing author: the connector fails to decode it.
    fixture: replaceResponse(
      linkedInSearchPeopleResultsFixture,
      0,
      withResults(
        people(3).map((entry, index) => (index === 0 ? { ...entry, author: null } : entry))
      )
    ),
    failure: searchDecodeFailure('results[0].author')
  },
  {
    // An ignored limit: more results than numResults asked for.
    fixture: replaceResponse(linkedInSearchNumResultsLimitFixture, 1, withResults(people(3))),
    failure: mismatch('expected 1 to 2 results for numResults: 2 (the control answered more)')
  },
  {
    // A 2xx that is not a profile object: the connector would return it as the profile.
    fixture: replaceResponse(linkedInSearchProfileFixture, 0, withStatus(200, '[]')),
    failure: mismatch('expected the 2xx profile answer to be a JSON object with at least one field')
  },
  {
    // An answer the connector does not recognise: it would report status unknown.
    fixture: replaceResponse(
      linkedInSearchEmailLookupFixture,
      0,
      withStatus(200, '{"message":"lookup failed"}')
    ),
    failure: mismatch(
      'expected the email answer to carry an email (string or null) or an email_queue_count'
    )
  },
  {
    // A 2xx error body for an unknown key: the connector would decode it as results.
    fixture: replaceResponse(
      linkedInSearchExaUnauthorizedFixture,
      0,
      withStatus(200, '{"results":[]}')
    ),
    failure: mismatch('expected linkedin_search.search with an unknown Exa key to fail')
  },
  {
    fixture: replaceResponse(
      linkedInSearchEnrichLayerUnauthorizedFixture,
      0,
      withStatus(200, '{"code":401,"description":"Invalid API Key","name":"Unauthorized"}')
    ),
    failure: mismatch('expected linkedin_search.profile with an unknown Enrich Layer key to fail')
  },
  {
    // An empty 2xx profile for a profile that does not exist.
    fixture: replaceResponse(linkedInSearchProfileNotFoundFixture, 0, withStatus(200, '{}')),
    failure: mismatch(
      'expected linkedin_search.profile for a profile URL that names no profile to fail'
    )
  }
]

describe('LinkedIn search conformance drills (one per case)', () => {
  it('cover every case with a tamper', () => {
    expect(tampers.map(tamper => tamper.fixture.caseId)).toEqual(caseIds)
  })

  for (const { fixture, failure } of tampers) {
    it.effect(`a tampered fixture fails exactly ${fixture.caseId}`, () =>
      Effect.gen(function* () {
        expect(yield* suiteFailures(withReplaced(fixture))).toEqual([
          { id: fixture.caseId, failure }
        ])
      })
    )
  }

  for (const caseId of caseIds) {
    it.effect(`a dropped fixture fails exactly ${caseId}`, () =>
      Effect.gen(function* () {
        const failures = yield* suiteFailures(
          linkedInSearchConformanceFixtures.filter(fixture => fixture.caseId !== caseId)
        )

        expect(failures.map(failure => failure.id)).toEqual([caseId])
      })
    )
  }
})

describe('LinkedIn search conformance claims in detail', () => {
  const onlyFailure = (fixture: WireFixture) =>
    Effect.gen(function* () {
      const failures = yield* suiteFailures(withReplaced(fixture))

      expect(failures.map(failure => failure.id)).toEqual([fixture.caseId])

      return failures[0]?.failure
    })

  it.effect('a search answer may omit every optional field the connector decodes', () =>
    Effect.gen(function* () {
      const bare = replaceResponse(
        linkedInSearchPeopleResultsFixture,
        0,
        withResults(people(3).map(entry => ({ url: entry.url, text: 'Synthetic text' })))
      )

      expect(yield* suiteFailures(withReplaced(bare))).toEqual([])
    })
  )

  it.effect('names a null totalResults, and never a null the connector does not decode', () =>
    Effect.gen(function* () {
      expect(
        yield* onlyFailure(
          replaceResponse(
            linkedInSearchPeopleResultsFixture,
            0,
            withStatus(200, JSON.stringify({ results: people(3), totalResults: null }))
          )
        )
      ).toEqual(searchDecodeFailure('totalResults'))

      // `author: 5` is why decoding fails; the nested null title is not read by the connector.
      expect(
        yield* onlyFailure(
          replaceResponse(
            linkedInSearchPeopleResultsFixture,
            0,
            withStatus(
              200,
              JSON.stringify({
                results: [
                  {
                    url: 'https://linkedin.example.com/in/synthetic-person-01',
                    text: 't',
                    author: 5,
                    extras: { title: null }
                  }
                ]
              })
            )
          )
        )
      ).toEqual(
        mismatch(
          'expected the 2xx answer of linkedin_search.search to decode as the connector reads it (Invalid response shape)'
        )
      )
    })
  )

  it.effect('names every null field the connector cannot decode', () =>
    Effect.gen(function* () {
      expect(
        yield* onlyFailure(
          replaceResponse(
            linkedInSearchPeopleResultsFixture,
            0,
            withResults(
              people(3).map((entry, index) =>
                index === 1 ? { ...entry, publishedDate: null, title: null } : entry
              )
            )
          )
        )
      ).toEqual(searchDecodeFailure('results[1].title, results[1].publishedDate'))
    })
  )

  for (const [label, edit, failure] of [
    [
      'more results than the default numResults',
      withResults(people(11)),
      mismatch('expected at most 10 results (the default numResults the connector sends)')
    ],
    [
      'a result without a url',
      withResults(people(3).map(({ url: _url, ...entry }) => entry)),
      mismatch('expected every result to carry a url')
    ],
    [
      'no result text, which the connector requests',
      withResults(people(3).map(({ text: _text, ...entry }) => entry)),
      mismatch('expected at least one result to carry the text the connector requests')
    ],
    [
      'no result at all (a seed problem)',
      withResults([]),
      mismatch('precondition: searchQuery must match at least one person')
    ],
    [
      'an answer without results',
      withStatus(200, JSON.stringify({ requestId: 'synthetic-request-0009' })),
      mismatch(
        'expected the 2xx answer of linkedin_search.search to decode as the connector reads it (Invalid response shape)'
      )
    ]
  ] as const) {
    it.effect(`the people search fails for ${label}`, () =>
      Effect.gen(function* () {
        expect(
          yield* onlyFailure(replaceResponse(linkedInSearchPeopleResultsFixture, 0, edit))
        ).toEqual(failure)
      })
    )
  }

  for (const [label, body] of [
    ['a null email (no address found)', { email: null }],
    ['a queued lookup', { email_queue_count: 3 }],
    [
      'an email with a status and message',
      { email: 'synthetic-person-01@example.com', status: 'found', message: 'ok' }
    ]
  ] as const) {
    it.effect(`the email lookup accepts ${label}`, () =>
      Effect.gen(function* () {
        const variant = replaceResponse(
          linkedInSearchEmailLookupFixture,
          0,
          withStatus(200, JSON.stringify(body))
        )

        expect(yield* suiteFailures(withReplaced(variant))).toEqual([])
      })
    )
  }

  it.effect('the limit case needs a control search that matches more than the limit', () =>
    Effect.gen(function* () {
      expect(
        yield* onlyFailure(
          replaceResponse(linkedInSearchNumResultsLimitFixture, 0, withResults(people(2)))
        )
      ).toEqual(
        mismatch(
          'precondition: searchQuery must match more than 2 people (the control search with numResults: 3 answered 2)'
        )
      )
    })
  )

  it.effect('the limit case fails when the limited search answers no result', () =>
    Effect.gen(function* () {
      expect(
        yield* onlyFailure(
          replaceResponse(linkedInSearchNumResultsLimitFixture, 1, withResults([]))
        )
      ).toEqual(mismatch('expected 1 to 2 results for numResults: 2 (the control answered more)'))
    })
  )

  it.effect('the email lookup fails when the connector would report status unknown', () =>
    Effect.gen(function* () {
      expect(
        yield* onlyFailure(
          replaceResponse(
            linkedInSearchEmailLookupFixture,
            0,
            withStatus(200, '{"email":null,"status":"unknown"}')
          )
        )
      ).toEqual(mismatch('expected linkedin_search.email never to report status "unknown"'))
    })
  )

  it.effect('the email lookup names a null queue count the connector cannot decode', () =>
    Effect.gen(function* () {
      expect(
        yield* onlyFailure(
          replaceResponse(
            linkedInSearchEmailLookupFixture,
            0,
            withStatus(200, '{"email_queue_count":null}')
          )
        )
      ).toEqual(
        mismatch(
          'expected the 2xx answer of linkedin_search.email to decode as the connector reads it; null where it reads a string or number: email_queue_count'
        )
      )
    })
  )

  it.effect('the profile must come back unchanged and non-empty', () =>
    Effect.gen(function* () {
      expect(
        yield* onlyFailure(replaceResponse(linkedInSearchProfileFixture, 0, withStatus(200, '{}')))
      ).toEqual(
        mismatch('expected the 2xx profile answer to be a JSON object with at least one field')
      )
    })
  )

  for (const [fixture, index, label, code] of [
    [
      linkedInSearchExaUnauthorizedFixture,
      0,
      'linkedin_search.search with an unknown Exa key',
      'linkedin_search_failed'
    ],
    [
      linkedInSearchEnrichLayerUnauthorizedFixture,
      1,
      'linkedin_search.email with an unknown Enrich Layer key',
      'linkedin_email_failed'
    ],
    [
      linkedInSearchProfileNotFoundFixture,
      0,
      'linkedin_search.profile for a profile URL that names no profile',
      'linkedin_profile_failed'
    ]
  ] as const) {
    it.effect(`a 5xx fails the 4xx claim: ${fixture.caseId} (${index})`, () =>
      Effect.gen(function* () {
        expect(
          yield* onlyFailure(
            replaceResponse(fixture, index, withStatus(502, '{"error":"Bad Gateway"}'))
          )
        ).toEqual(mismatch(`expected ${label} to answer a 4xx status (${code})`))
      })
    )
  }

  it.effect(
    'error statuses other than the guessed ones still pass: only the 4xx class counts',
    () =>
      Effect.gen(function* () {
        const variants = [
          replaceResponse(linkedInSearchExaUnauthorizedFixture, 0, withStatus(403, '{}')),
          replaceResponse(linkedInSearchEnrichLayerUnauthorizedFixture, 1, withStatus(403, '')),
          replaceResponse(linkedInSearchProfileNotFoundFixture, 0, withStatus(400, 'not json'))
        ]

        expect(yield* suiteFailures(withReplaced(...variants))).toEqual([])
      })
  )

  it.effect('a missing seed fails before any request', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const ledgers = yield* Ref.make(new Map<string, ReplayLedgerApi>())

      const report = yield* runConformance(linkedInSearchConformanceCases, {
        target: { kind: 'replay' },
        now,
        layer: ledgerCaseLayer(ledgers, linkedInSearchConformanceFixtures, {})
      })

      const failed = report.results.filter(result => result.status === 'failed')

      expect(failed.map(result => [result.id, result.failure?.message])).toEqual([
        [caseIds[0], 'precondition: LinkedInSearchConformanceConfig.searchQuery is not configured'],
        [caseIds[1], 'precondition: LinkedInSearchConformanceConfig.searchQuery is not configured'],
        [caseIds[2], 'precondition: LinkedInSearchConformanceConfig.profileUrl is not configured'],
        [caseIds[3], 'precondition: LinkedInSearchConformanceConfig.profileUrl is not configured'],
        [caseIds[5], 'precondition: LinkedInSearchConformanceConfig.profileUrl is not configured'],
        [
          caseIds[6],
          'precondition: LinkedInSearchConformanceConfig.absentProfileUrl is not configured'
        ]
      ])

      for (const result of failed) {
        expect((yield* ledgerOf(ledgers, result.id)).entries).toEqual([])
      }
    })
  )

  it.effect('a transport failure fails every case and carries no key', () =>
    Effect.gen(function* () {
      yield* atTestNow

      const connectionReset = (request: HttpClientRequest.HttpClientRequest) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: 'connection reset' })
        })

      const dropping = HttpClient.make(request => Effect.fail(connectionReset(request)))

      const report = yield* runConformance(linkedInSearchConformanceCases, {
        target: { kind: 'replay' },
        now,
        layer: () => portsOver(Layer.succeed(HttpClient.HttpClient, dropping))
      })

      expect(report.summary.failed).toBe(7)
      expect(JSON.stringify(report)).not.toContain(syntheticExaKey)
      expect(JSON.stringify(report)).not.toContain(syntheticEnrichLayerKey)
      // The transport failure itself is reported, never a request-shape mismatch.
      expect(report.results.map(result => result.failure?.tag)).toEqual(
        caseIds.map(() => 'ConnectorError')
      )
    })
  )
})

describe('LinkedIn search rate limiting (not a case)', () => {
  it.effect('a 429 keeps its status and raw body; no Retry-After is mapped', () =>
    Effect.gen(function* () {
      const body = JSON.stringify({
        requestId: 'synthetic-request-0429',
        error: 'Too many requests'
      })

      const rateLimited: WireFixture = {
        ...linkedInSearchExaUnauthorizedFixture,
        id: 'linkedin-search.rate-limit.synthetic',
        exchanges: [
          {
            request: linkedInSearchExaUnauthorizedFixture.exchanges[0].request,
            response: {
              status: 429,
              headers: { 'content-type': 'application/json', 'retry-after': '7' },
              body
            }
          }
        ]
      }

      const result = yield* linkedInSearchAction
        .executeTyped({
          integration: linkedInSearchConformanceIntegration(),
          input: LinkedInSearchInput.make({ query: 'yolk-conformance unauthorized probe' })
        })
        .pipe(Effect.provide(portsOver(ReplayHttpClient.layer([rateLimited]))))

      expect(result).toMatchObject({
        _tag: 'Failure',
        error: { code: 'linkedin_search_failed', status: 429, underlying: body }
      })
      expect(
        Predicate.isTagged(result, 'Failure') ? result.error.retryAfterMs : 'success'
      ).toBeUndefined()
    })
  )
})
