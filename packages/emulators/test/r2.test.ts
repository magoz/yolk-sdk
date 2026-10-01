import { describe, expect, it } from 'vitest'
import { Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import {
  isPortCredentialKey,
  scanPortFixtureForSecrets,
  type PortFixture
} from '@yolk-sdk/conformance/fixture'
import { findR2PortFixtureSecrets } from '@yolk-sdk/connectors/r2-storage/conformance'
import {
  R2EmulatorInputInvalid,
  makeR2Emulator,
  r2EmulatorDefaultSeed,
  r2EmulatorFixtures,
  r2EmulatorRoutes,
  type R2Emulator,
  type R2EmulatorFault,
  type R2EmulatorFixture,
  type R2EmulatorLedgerEntry,
  type R2EmulatorSeed
} from '../src/r2.ts'
import {
  isR2CredentialKey,
  r2CredentialKeyNames,
  r2CredentialParamNames,
  r2TokenPatterns
} from '../src/r2-guard.ts'

const fixture = (id: string): R2EmulatorFixture =>
  r2EmulatorFixtures.find(candidate => candidate.id === id) ?? expect.fail(`no fixture ${id}`)

const synthetic = (id: string) => fixture(`r2.${id}.synthetic`)

const call = (emulator: R2Emulator, id: string) => {
  const recorded = synthetic(id)

  return emulator.call(recorded.port, recorded.method, recorded.request)
}

const answerOf = (recorded: R2EmulatorFixture) =>
  recorded.failure === undefined ? { response: recorded.response } : { failure: recorded.failure }

const presign = synthetic('presign.put-upload-url.presign')

const withinBudget = synthetic('objects.get-max-bytes.within-budget')

const create = synthetic('objects.create-if-absent.create')

const decodeObject = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))

const asObject = (value: unknown): Schema.JsonObject =>
  Option.getOrElse(decodeObject(value), () => expect.fail('not an object'))

const presignRequest = asObject(presign.request)

const getRequest = asObject(withinBudget.request)

const putRequest = asObject(create.request)

const failure = { kind: 'error', code: 'transport_failed', message: 'Synthetic fault.' } as const

const syntheticBearerToken = 'synthetic-bearer-token-0001'

/**
 * One synthetic sample per entry of `r2TokenPatterns`, in order (assembled from parts so no
 * literal reads as a real token): a new pattern without a sample fails the parity test.
 */
const tokenSamples: ReadonlyArray<readonly [string, string]> = [
  ['bearer token', `Bearer ${syntheticBearerToken}`],
  ['secret key', `sk-${'synthetic-key'}-0000000000`],
  ['Stripe-style key', `rk_test_${'SYNTHETIC'}0000000000`],
  ['xAI key', `xai-${'SYNTHETIC'}00000000000000`],
  ['Vercel key', `vck_${'SYNTHETIC'}0000000000`],
  ['GitHub token', `ghs_${'SYNTHETIC'}00000000000000`],
  ['fine-grained GitHub token', `github_pat_${'SYNTHETIC'}_00000000000000`],
  ['AWS access key id', `AKIA${'SYNTHETIC'}0000000`],
  ['Google API key', `AIza${'SyntheticGoogleKey'}_${'0'.repeat(16)}`],
  ['Slack token', `xoxb-${'synthetic'}-0000`],
  ['JSON Web Token', `eyJ${'SYNTHETIC'}.eyJ${'SYNTHETIC'}.${'SYNTHETIC'}sig`],
  ['private key', `-----BEGIN ${'SYNTHETIC'} PRIVATE KEY-----`]
]

/** The API-key-shaped samples (every token sample but the bearer). */
const tokens = tokenSamples.slice(1)

const awsKeySample =
  tokenSamples.find(([label]) => label === 'AWS access key id')?.[1] ?? expect.fail('no sample')

const reasons = {
  unknown: 'unknown-method: the port and method have no emulated route',
  invalid: 'invalid-request: the request is not a JSON object',
  credential:
    'credential-in-request: the request carries a credential outside its credential fields',
  uncheckable: 'uncheckable-body: a bodyBase64 is not canonical base64 of UTF-8 text',
  uncheckableRequest: 'uncheckable-request: the request could not be checked',
  noMatch: 'no-matching-fixture: no fixture matches this request',
  conflict: 'state-conflict: no matching fixture is consistent with the emulated bucket'
} as const

/** The ledgered reason code of each refusal. */
const reasonCodes = {
  unknown: 'unknown-method',
  invalid: 'invalid-request',
  credential: 'credential-in-request',
  uncheckable: 'uncheckable-body',
  uncheckableRequest: 'uncheckable-request',
  noMatch: 'no-matching-fixture',
  conflict: 'state-conflict'
} as const

/** Runtime-only input for validation tests: a JSON copy typed as whatever the API expects. */
const untyped = <T>(value: unknown): T => JSON.parse(JSON.stringify(value))

/** One valid call per route: the answer a match-all fault takes over. */
const validCall = {
  'R2Presigner.presignPutObject': ['R2Presigner', 'presignPutObject', presignRequest],
  'R2ObjectClient.get': ['R2ObjectClient', 'get', getRequest],
  'R2ObjectClient.put': ['R2ObjectClient', 'put', putRequest]
} as const

type RouteName = keyof typeof validCall

/** Every text a reader of the emulator can see: answers, ledger, state, coverage, faults. */
const observable = (emulator: R2Emulator, replies: ReadonlyArray<unknown>) =>
  JSON.stringify([
    replies,
    emulator.ledger.entries(),
    emulator.state(),
    emulator.seed(),
    emulator.coverage(),
    emulator.faults.list()
  ])

/**
 * A refusal row: with a match-all fault on `route` installed, the call answers the constant
 * not-emulated text, is ledgered, changes no state, and leaves the fault unused; the fault then
 * still answers the next valid request of that route. Returns the real refusal reply.
 */
const expectRefused = (
  emulator: R2Emulator,
  route: RouteName,
  [port, method, request]: readonly [string, string, Schema.Json],
  reason: keyof typeof reasons
) => {
  const before = emulator.state()

  const fault = emulator.faults.add({
    kind: 'failure',
    port: validCall[route][0],
    method: validCall[route][1],
    failure
  })

  const reply = emulator.call(port, method, request)

  expect(reply).toEqual({ notEmulated: { reason: reasons[reason] } })
  // Every refusal is ledgered with constant text only: no request text, no body length.
  expect(emulator.ledger.entries().at(-1)).toEqual({
    seq: emulator.ledger.entries().length,
    port: reason === 'unknown' || reason === 'uncheckableRequest' ? '<unrecognised>' : port,
    method: reason === 'unknown' || reason === 'uncheckableRequest' ? '<unrecognised>' : method,
    request: '<redacted>',
    outcome: 'not-emulated',
    evidence:
      reason === 'unknown' || reason === 'uncheckableRequest' ? 'unknown-method' : 'unverified',
    reason: reasonCodes[reason]
  })
  expect(emulator.state()).toEqual(before)
  expect(emulator.faults.list().find(item => item.id === fault.id)).toMatchObject({
    applied: 0
  })

  const [validPort, validMethod, validRequest] = validCall[route]

  expect(emulator.call(validPort, validMethod, validRequest)).toEqual({ failure })
  expect(emulator.state()).toEqual(before)
  emulator.faults.clear()

  return reply
}

describe('R2 emulator: answers only from fixtures', () => {
  it('answers a recorded request with the recorded response and ledgers it', () => {
    const emulator = makeR2Emulator()

    expect(emulator.call('R2Presigner', 'presignPutObject', presign.request)).toEqual({
      response: presign.response
    })
    expect(emulator.ledger.entries()).toEqual([
      {
        seq: 1,
        port: 'R2Presigner',
        method: 'presignPutObject',
        request: presign.request,
        outcome: 'answered',
        evidence: 'unverified',
        fixtureId: presign.id
      }
    ])
  })

  it('answers failure fixtures as failures', () => {
    const emulator = makeR2Emulator()

    for (const id of [
      'objects.get-max-bytes.over-budget',
      'objects.get-expected-etag.stale',
      'objects.get-missing-not-found.get'
    ]) {
      expect(call(emulator, id), id).toEqual(answerOf(synthetic(id)))
    }
  })

  it('allows only the documented latitude: credential fields and JSON key order', () => {
    const emulator = makeR2Emulator()

    const reply = emulator.call('R2Presigner', 'presignPutObject', {
      contentType: 'text/plain',
      key: presignRequest.key ?? null,
      accessKeyId: 'live-key-id-0001',
      secretAccessKey: 'live-secret-0001',
      credentials: { sessionToken: 'live-session-0001' },
      bucket: presignRequest.bucket ?? null,
      endpoint: presignRequest.endpoint ?? null
    })

    expect(reply).toEqual({ response: presign.response })
    expect(emulator.ledger.entries()[0]?.request).toEqual(presign.request)
    expect(observable(emulator, [])).not.toMatch(/live-|accessKeyId|secretAccessKey|session/)

    // Every other field is compared.
    const variants: ReadonlyArray<Schema.JsonObject> = [
      { ...presignRequest, endpoint: 'https://other-account.r2.example.test' },
      { ...presignRequest, bucket: 'other-bucket' },
      { ...presignRequest, key: '/yolk-conformance/run-synthetic/presign.txt' },
      { ...presignRequest, contentType: 'text/plain; charset=utf-8' },
      { ...presignRequest, expires: 900 }
    ]

    for (const request of variants) {
      expect(
        expectRefused(
          emulator,
          'R2Presigner.presignPutObject',
          ['R2Presigner', 'presignPutObject', request],
          'noMatch'
        ),
        JSON.stringify(request)
      ).toEqual({ notEmulated: { reason: reasons.noMatch } })
    }
  })

  it('drops a field for every copied credential key name, each one the shared scan drops', () => {
    // One sample per entry of `r2CredentialKeyNames`, in order: a new entry without a sample fails.
    const samples = [
      'Credentials',
      'access_token',
      'refreshToken',
      'id-token',
      'AUTH_TOKEN',
      'apiToken',
      'sessionToken',
      'private_token',
      'bearerToken',
      'oauth_token',
      'token',
      'client_secret',
      'secretKey',
      'private-key',
      'password',
      'passwd',
      'API_KEY',
      'access_key_id',
      'secretAccessKey',
      'Authorization'
    ]

    expect(samples).toHaveLength(r2CredentialKeyNames.length)

    samples.forEach((sample, index) => {
      expect(new RegExp(`^(?:${r2CredentialKeyNames[index]})$`, 'i').test(sample), sample).toBe(
        true
      )
      expect(isPortCredentialKey(sample), sample).toBe(true)
      expect(isR2CredentialKey(sample), sample).toBe(true)

      const emulator = makeR2Emulator()

      const reply = emulator.call('R2Presigner', 'presignPutObject', {
        ...presignRequest,
        [sample]: '<v>'
      })

      // A dropped key matches the fixture, and only the fixture's request is recorded.
      expect(reply, sample).toEqual({ response: presign.response })
      expect(emulator.ledger.entries()[0]?.request, sample).toEqual(presign.request)
    })
  })

  it('compares every other key, refusing with constant text whatever it is named', () => {
    for (const key of [
      'accountId',
      'account_id',
      'aws_secret_access_key',
      'aws_session_token',
      'x-api-key',
      'credentialRef',
      'tokens',
      'region',
      'maxBytes'
    ]) {
      expect(isPortCredentialKey(key), key).toBe(false)
      expect(isR2CredentialKey(key), key).toBe(false)

      const emulator = makeR2Emulator()

      expectRefused(
        emulator,
        'R2Presigner.presignPutObject',
        ['R2Presigner', 'presignPutObject', { ...presignRequest, [key]: 'synthetic-value-0002' }],
        'noMatch'
      )
      expect(observable(emulator, []), key).not.toContain('synthetic-value-0002')
      expect(observable(emulator, []), key).not.toContain(`"${key}"`)
    }
  })
})

describe('R2 emulator: fails closed', () => {
  it('refuses an unknown port or method with a constant ledger entry', () => {
    const emulator = makeR2Emulator()

    for (const [port, method] of [
      ['R2ObjectClient', 'delete'],
      ['R2Presigner', 'get'],
      ['R2Objects', 'put'],
      ['R2ObjectClient', 'put.synthetic-live-secret-value']
    ] as const) {
      expect(
        expectRefused(emulator, 'R2ObjectClient.get', [port, method, getRequest], 'unknown')
      ).toEqual({ notEmulated: { reason: reasons.unknown } })
      expect(emulator.ledger.entries().at(-2)).toEqual({
        seq: emulator.ledger.entries().length - 1,
        port: '<unrecognised>',
        method: '<unrecognised>',
        request: '<redacted>',
        outcome: 'not-emulated',
        evidence: 'unknown-method',
        reason: 'unknown-method'
      })
    }

    expect(observable(emulator, [])).not.toContain('synthetic-live-secret-value')
  })

  it('refuses a request that is not a JSON object with a constant ledger entry', () => {
    const emulator = makeR2Emulator()

    for (const request of [
      ['synthetic-live-secret-value'],
      'synthetic-live-secret-value',
      null,
      7
    ]) {
      expectRefused(emulator, 'R2ObjectClient.get', ['R2ObjectClient', 'get', request], 'invalid')
      expect(emulator.ledger.entries().at(-2)).toMatchObject({
        port: 'R2ObjectClient',
        method: 'get',
        request: '<redacted>',
        reason: 'invalid-request'
      })
    }

    expect(observable(emulator, [])).not.toContain('synthetic-live-secret-value')
  })

  it('refuses requests that differ from every fixture', () => {
    const emulator = makeR2Emulator()

    const variants: ReadonlyArray<readonly [RouteName, Schema.JsonObject]> = [
      ['R2ObjectClient.get', { ...getRequest, maxBytes: 1024 }],
      ['R2ObjectClient.get', { ...getRequest, key: 'fixtures/other.txt' }],
      ['R2ObjectClient.get', { ...getRequest, expectedEtag: '"a0b1"' }],
      ['R2ObjectClient.get', { bucket: getRequest.bucket ?? null, key: getRequest.key ?? null }],
      ['R2ObjectClient.put', { ...putRequest, maxUploadBytes: 2048 }],
      ['R2ObjectClient.put', { ...putRequest, bodyBase64: btoa('other synthetic body') }],
      ['R2ObjectClient.put', { ...putRequest, condition: { kind: 'none' } }],
      // Another run id: the fixtures record only `run-synthetic`.
      [
        'R2ObjectClient.put',
        { ...putRequest, key: 'yolk-conformance/run-0123abcd/create-if-absent.txt' }
      ]
    ]

    for (const [route, request] of variants) {
      const [port, method] = validCall[route]

      // The refusal is ledgered with constant text only (asserted by `expectRefused`).
      expectRefused(emulator, route, [port, method, request], 'noMatch')
      expect(observable(emulator, []), JSON.stringify(request)).not.toMatch(
        /run-0123abcd|other synthetic body|"kind":"none"|fixtures\/other/
      )
    }
  })

  it('refuses an own __proto__ key at any depth as invalid, with a constant entry', () => {
    const withKey = (request: Schema.JsonObject, json: string): Schema.JsonObject =>
      asObject(JSON.parse(`${JSON.stringify(request).slice(0, -1)},${json}}`))

    const rows: ReadonlyArray<readonly [RouteName, Schema.JsonObject]> = [
      ['R2ObjectClient.get', withKey(getRequest, '"__proto__":7')],
      ['R2ObjectClient.get', withKey(getRequest, '"__proto__":{"maxBytes":1}')],
      [
        'R2ObjectClient.put',
        asObject(
          JSON.parse(
            JSON.stringify(putRequest).replace(
              '"kind":"absent"',
              '"kind":"absent","__proto__":{"x":1}'
            )
          )
        )
      ],
      ['R2ObjectClient.get', withKey(getRequest, '"credentials":{"__proto__":"x"}')]
    ]

    for (const [route, request] of rows) {
      const [port, method] = validCall[route]
      const emulator = makeR2Emulator()

      expectRefused(emulator, route, [port, method, request], 'invalid')
    }

    expect(Object.hasOwn(rows[0]?.[1] ?? {}, '__proto__')).toBe(true)
  })

  it('answers a request the checks cannot walk with a constant entry, never a throw', () => {
    const cyclic: Array<Schema.Json> = []

    cyclic.push(cyclic)

    let deep: Schema.Json = 'synthetic-deep-value'

    for (let depth = 0; depth < 200_000; depth += 1) {
      deep = [deep]
    }

    for (const request of [
      { ...getRequest, extra: cyclic },
      { ...getRequest, extra: deep }
    ]) {
      const emulator = makeR2Emulator()

      expectRefused(
        emulator,
        'R2ObjectClient.get',
        ['R2ObjectClient', 'get', request],
        'uncheckableRequest'
      )
      expect(observable(emulator, [])).not.toContain('synthetic-deep-value')
    }
  })

  it('refuses a matching fixture that contradicts the bucket (state-conflict)', () => {
    const emulator = makeR2Emulator()
    const stale = synthetic('objects.update-if-match.stale')

    // Nothing created the update key yet, so a stale If-Match has no object to conflict with.
    expectRefused(
      emulator,
      'R2ObjectClient.put',
      [stale.port, stale.method, stale.request],
      'conflict'
    )

    // The read of a created object before it was created.
    const read = synthetic('objects.create-if-absent.read')

    expectRefused(
      emulator,
      'R2ObjectClient.get',
      [read.port, read.method, read.request],
      'conflict'
    )
    expect(emulator.state()).toEqual(r2EmulatorDefaultSeed)
  })
})

describe('R2 emulator: credential guard', () => {
  const secret = 'synthetic-live-secret-value'

  const percent = (text: string) =>
    [...text].map(character => `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')

  const jsonEscaped = (text: string) =>
    [...text]
      .map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join('')

  const entities = (text: string) =>
    [...text].map(character => `&#${character.charCodeAt(0)};`).join('')

  const hexEntities = (text: string) =>
    [...text].map(character => `&#x${character.charCodeAt(0).toString(16)};`).join('')

  const repeats: ReadonlyArray<readonly [string, Schema.JsonObject]> = [
    ['raw in a value', { ...getRequest, key: `fixtures/${secret}.txt` }],
    ['percent-encoded', { ...getRequest, key: percent(secret) }],
    ['percent-encoded twice', { ...getRequest, key: encodeURIComponent(percent(secret)) }],
    ['JSON-escaped', { ...getRequest, key: jsonEscaped(secret) }],
    [
      'escaped then percent-encoded',
      { ...getRequest, key: encodeURIComponent(jsonEscaped(secret)) }
    ],
    ['as a decimal HTML reference', { ...getRequest, key: `&#115;${secret.slice(1)}` }],
    ['as a \\x escape', { ...getRequest, key: `\\x73${secret.slice(1)}` }],
    ['fully entity-encoded', { ...getRequest, key: entities(secret) }],
    ['fully hex-entity-encoded', { ...getRequest, key: hexEntities(secret) }],
    ['as an entity-encoded object key', { ...getRequest, extra: { [entities(secret)]: true } }],
    ['as an object key', { ...getRequest, extra: { [secret]: true } }],
    ['as a percent-encoded key', { ...getRequest, [percent(secret)]: 1 }],
    ['in an array', { ...getRequest, tags: ['a', `${secret}`] }]
  ]

  for (const [label, request] of repeats) {
    it(`refuses a request that repeats a credential value ${label}`, () => {
      const emulator = makeR2Emulator()

      const reply = expectRefused(
        emulator,
        'R2ObjectClient.get',
        ['R2ObjectClient', 'get', { ...request, accessKeyId: secret }],
        'credential'
      )

      expect(emulator.ledger.entries()[0]).toEqual({
        seq: 1,
        port: 'R2ObjectClient',
        method: 'get',
        request: '<redacted>',
        outcome: 'not-emulated',
        evidence: 'unverified',
        reason: 'credential-in-request'
      })

      const text = observable(emulator, [reply])

      for (const form of [secret, percent(secret), encodeURIComponent(secret), 'synthetic-live']) {
        expect(text, label).not.toContain(form)
      }
    })
  }

  it('repeats a non-ASCII credential value through a JSON escape the shared closure keeps', () => {
    const emulator = makeR2Emulator()
    const nonAscii = 'synthetic-live-s\u00e9cret'

    expectRefused(
      emulator,
      'R2ObjectClient.get',
      [
        'R2ObjectClient',
        'get',
        { ...getRequest, key: 'synthetic-live-s\\u00e9cret', secretAccessKey: nonAscii }
      ],
      'credential'
    )
    expect(observable(emulator, [])).not.toContain('synthetic-live-s')
  })

  it('guards the keys inside a credential field like its values', () => {
    const emulator = makeR2Emulator()

    expectRefused(
      emulator,
      'R2ObjectClient.get',
      [
        'R2ObjectClient',
        'get',
        {
          ...getRequest,
          key: 'fixtures/synthetic-live-key.txt',
          credentials: { 'synthetic-live-key': true }
        }
      ],
      'credential'
    )
    expect(observable(emulator, [])).not.toContain('synthetic-live-key')
  })

  it('matches numbers by their digit strings as well as their printed form', () => {
    const rows: ReadonlyArray<Schema.JsonObject> = [
      // A zero-padded string credential repeated as a number.
      { ...getRequest, part: 12345678, accessKeyId: '0012345678' },
      // A number credential repeated inside a zero-padded string.
      { ...getRequest, key: 'fixtures/0012345678', secretAccessKey: 12345678 },
      // A large number printed as `1e+21` repeated as its digits, and the reverse.
      { ...getRequest, key: `fixtures/1${'0'.repeat(21)}`, secretAccessKey: 1e21 },
      { ...getRequest, part: 1e21, secretAccessKey: `1${'0'.repeat(21)}` },
      { ...getRequest, part: 1e21, secretAccessKey: '1e21' }
    ]

    for (const request of rows) {
      const emulator = makeR2Emulator()

      expectRefused(
        emulator,
        'R2ObjectClient.get',
        ['R2ObjectClient', 'get', request],
        'credential'
      )
      expect(observable(emulator, []), JSON.stringify(request)).not.toMatch(/12345678|e\+21|0{21}/)
    }
  })

  it('refuses a sample of every copied credential parameter name, as the shared scan does', () => {
    // One sample per entry of `r2CredentialParamNames`, in order.
    const samples = [
      'k?api-key=v1',
      'key=v1',
      'k&token=v1',
      'k?accessToken=v1',
      'k?refresh_token=v1',
      'k?idtoken=v1',
      'auth=v1',
      'k?secret=v1',
      'password=v1',
      'k?client-secret=v1',
      'k?X-Amz-Signature=v1',
      'k?x-amz-credential=v1',
      'k?X-AMZ-SECURITY-TOKEN=v1'
    ]

    expect(samples).toHaveLength(r2CredentialParamNames.length)

    samples.forEach((sample, index) => {
      expect(
        new RegExp(`(?:^|[?&])(?:${r2CredentialParamNames[index]})=`, 'i').test(sample),
        sample
      ).toBe(true)

      const asFixture: PortFixture = {
        id: 'r2.param-sample',
        port: 'R2ObjectClient',
        method: 'get',
        request: { ...getRequest, key: sample },
        response: null
      }

      expect(
        scanPortFixtureForSecrets(asFixture).map(issue => issue.kind),
        sample
      ).toContain('credential_query_param')

      const emulator = makeR2Emulator()

      expectRefused(
        emulator,
        'R2ObjectClient.get',
        ['R2ObjectClient', 'get', { ...getRequest, key: sample }],
        'credential'
      )
    })
  })

  it('refuses a sample of every copied token pattern, as the shared scan does', () => {
    expect(tokenSamples).toHaveLength(r2TokenPatterns.length)

    tokenSamples.forEach(([label, sample], index) => {
      expect(r2TokenPatterns[index]?.test(sample), label).toBe(true)

      const asFixture: PortFixture = {
        id: 'r2.token-sample',
        port: 'R2ObjectClient',
        method: 'get',
        request: { ...getRequest, key: sample },
        response: null
      }

      expect(
        scanPortFixtureForSecrets(asFixture).some(
          issue => issue.kind === 'bearer_token' || issue.kind === 'api_key'
        ),
        label
      ).toBe(true)

      const emulator = makeR2Emulator()

      expectRefused(
        emulator,
        'R2ObjectClient.get',
        ['R2ObjectClient', 'get', { ...getRequest, key: sample }],
        'credential'
      )
    })
  })

  it('guards nested and numeric credential values, numbers included', () => {
    const emulator = makeR2Emulator()

    expectRefused(
      emulator,
      'R2ObjectClient.get',
      ['R2ObjectClient', 'get', { ...getRequest, credentials: { secretAccessKey: 1048576 } }],
      'credential'
    )
    expectRefused(
      emulator,
      'R2ObjectClient.get',
      ['R2ObjectClient', 'get', { ...getRequest, nested: [{ token: '1048576' }] }],
      'credential'
    )
    // Only the valid requests the faults answered are recorded; both refusals are constant.
    expect(
      emulator.ledger
        .entries()
        .filter(entry => entry.outcome === 'not-emulated')
        .map(entry => entry.request)
    ).toEqual(['<redacted>', '<redacted>'])
  })

  it('guards credential values of any length: a short value repeated anywhere refuses', () => {
    for (const value of ['txt', 'ob', '.']) {
      const emulator = makeR2Emulator()

      expectRefused(
        emulator,
        'R2ObjectClient.get',
        ['R2ObjectClient', 'get', { ...getRequest, secretAccessKey: value }],
        'credential'
      )
    }

    // An empty value guards nothing; a value repeated nowhere is simply dropped.
    for (const value of ['', 'Q#Z']) {
      expect(
        makeR2Emulator().call('R2ObjectClient', 'get', { ...getRequest, secretAccessKey: value }),
        value
      ).toEqual({ response: withinBudget.response })
    }
  })

  const sigV4: ReadonlyArray<readonly [string, Schema.JsonObject]> = [
    ['a live signature', { ...getRequest, key: 'k?X-Amz-Signature=0a1b2c3d' }],
    ['a live credential', { ...getRequest, key: 'k?X-Amz-Credential=AKIDLIVE%2F20260930' }],
    ['a session token', { ...getRequest, key: 'k?x-amz-security-token=live' }],
    ['a credential name in prose', { ...getRequest, key: 'see X-Amz-Credential' }],
    ['a percent-encoded name', { ...getRequest, key: 'X%2DAmz%2DSignature' }],
    ['a twice percent-encoded name', { ...getRequest, key: 'X%252DAmz%252DSignature' }],
    ['a JSON-escaped name', { ...getRequest, key: 'X\\u002dAmz-Credential' }],
    ['an HTML-escaped name', { ...getRequest, key: 'X&#45;Amz-Credential' }],
    [
      'an encoded placeholder',
      { ...getRequest, key: 'X%2DAmz-Signature=yolk-synthetic-signature' }
    ],
    ['a name as a key', { ...getRequest, 'X-Amz-Security-Token': 'live' }],
    ['a shared credential parameter', { ...getRequest, key: 'k?token=live-token' }],
    ['a form-encoded password', { ...getRequest, key: 'password=live' }]
  ]

  for (const [label, request] of sigV4) {
    it(`refuses ${label} under the R2 guard rules, with constant text`, () => {
      const emulator = makeR2Emulator()

      expectRefused(
        emulator,
        'R2ObjectClient.get',
        ['R2ObjectClient', 'get', request],
        'credential'
      )
      expect(emulator.ledger.entries()[0]?.request).toBe('<redacted>')
      expect(observable(emulator, [])).not.toMatch(/live|0a1b2c3d|amz|%2D|see /i)
    })
  }

  it('accepts the exact canonical placeholders as no credential (a plain no-match)', () => {
    const emulator = makeR2Emulator()

    const request = {
      ...getRequest,
      key: 'k?X-Amz-Credential=yolk-synthetic-access-key-id%2F20260930%2Fauto%2Fs3%2Faws4_request&X-Amz-Signature=yolk-synthetic-signature'
    }

    expectRefused(emulator, 'R2ObjectClient.get', ['R2ObjectClient', 'get', request], 'noMatch')
    expect(observable(emulator, [])).not.toContain('yolk-synthetic-signature')
  })

  it('refuses at least every string either port scan of the R2 guard flags', () => {
    const corpus = [
      ...sigV4.flatMap(([, request]) =>
        request.key === getRequest.key ? [] : [String(request.key ?? '')]
      ),
      'https://h.example.test/b/k?X-Amz-Signature=yolk-synthetic-signature-suffix',
      'https://h.example.test/b/k?X-Amz-Credential=yolk-synthetic-access-key-id/20260930/auto/s3/aws4_request',
      'https://h.example.test/b/k?a=1&amp;X-Amz-Signature=live',
      'https://h.example.test/b/k?api_key=live',
      'yolk-conformance/run-synthetic/presign.txt',
      'k?x-id=PutObject',
      ...tokens.map(([, token]) => token),
      `Bearer ${syntheticBearerToken}`,
      'X-Amz-Date=20260930T120000Z'
    ]

    for (const text of corpus) {
      const asFixture: PortFixture = {
        id: 'r2.corpus',
        port: 'R2ObjectClient',
        method: 'get',
        request: { ...getRequest, key: text },
        response: null
      }

      const flagged =
        scanPortFixtureForSecrets(asFixture).length > 0 ||
        findR2PortFixtureSecrets(asFixture).length > 0

      const reply = makeR2Emulator().call('R2ObjectClient', 'get', { ...getRequest, key: text })

      if (flagged) {
        expect(reply, text).toEqual({ notEmulated: { reason: reasons.credential } })
      } else {
        expect(reply, text).toEqual({ notEmulated: { reason: reasons.noMatch } })
      }
    }
  })
})

describe('R2 emulator: put bodies and token patterns', () => {
  const secret = 'synthetic-live-secret-value'

  const utf8Base64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))

  /** `base64` with `separator` inserted after `at` characters, as a line-wrapping encoder does. */
  const wrapped = (base64: string, at: number, separator: string) =>
    `${base64.slice(0, at)}${separator}${base64.slice(at)}`

  const putWith = (bodyBase64: Schema.Json, extra: Schema.JsonObject = {}) =>
    ['R2ObjectClient', 'put', { ...putRequest, bodyBase64, ...extra }] as const

  /** The refusal is constant and nothing the request carried shows anywhere. */
  const expectConstant = (
    emulator: R2Emulator,
    reply: unknown,
    reason: R2EmulatorLedgerEntry['reason'],
    hidden: ReadonlyArray<string>
  ) => {
    expect(emulator.ledger.entries()[0]).toEqual({
      seq: 1,
      port: 'R2ObjectClient',
      method: 'put',
      request: '<redacted>',
      outcome: 'not-emulated',
      evidence: 'unverified',
      reason
    })

    const text = observable(emulator, [reply])

    for (const form of hidden) {
      expect(text, form).not.toContain(form)
    }
  }

  it('records put bytes only as their decoded length, never the base64', () => {
    const emulator = makeR2Emulator()

    expect(call(emulator, 'objects.create-if-absent.create')).toHaveProperty('response')
    expect(emulator.ledger.entries()[0]).toEqual({
      seq: 1,
      port: 'R2ObjectClient',
      method: 'put',
      request: { ...putRequest, bodyBase64: '<redacted>' },
      bodyBytes: atob(String(putRequest.bodyBase64)).length,
      outcome: 'answered',
      evidence: 'unverified',
      fixtureId: create.id
    })
    expect(JSON.stringify(emulator.ledger.entries())).not.toContain(String(putRequest.bodyBase64))
  })

  const credentialBodies: ReadonlyArray<readonly [string, string]> = [
    ['a repeated credential value', `synthetic body holding ${secret}`],
    ['a percent-encoded credential value', `synthetic body ${encodeURIComponent(`/${secret}`)}`],
    ['a JSON-escaped credential value', `{"v":"\\u0073${secret.slice(1)}"}`],
    ['a bearer token', `Authorization: Bearer ${syntheticBearerToken}`],
    ['a SigV4 signature', 'https://h.example.test/b/k?X-Amz-Signature=0a1b2c3d'],
    ['an API key', `key ${awsKeySample}`],
    ['an entity-encoded credential value', `body &#115;${secret.slice(1)}`],
    ['a \\x-escaped credential value', `body \\x73${secret.slice(1)}`]
  ]

  for (const [label, text] of credentialBodies) {
    it(`refuses a base64 body holding ${label}, with a constant entry`, () => {
      const emulator = makeR2Emulator()
      const body = utf8Base64(text)

      const reply = expectRefused(
        emulator,
        'R2ObjectClient.put',
        putWith(body, { accessKeyId: secret }),
        'credential'
      )

      expectConstant(emulator, reply, 'credential-in-request', [
        secret,
        body,
        'synthetic body',
        syntheticBearerToken,
        '0a1b2c3d'
      ])
    })
  }

  const uncheckable: ReadonlyArray<readonly [string, Schema.Json]> = [
    ['not base64', 'not base64!'],
    ['unpadded', utf8Base64('synthetic body').replace(/=+$/, '')],
    ['line-wrapped', wrapped(utf8Base64('synthetic body, wrapped'), 8, '\n')],
    [
      'the URL-safe alphabet',
      utf8Base64('synthetic body??>>').replaceAll('+', '-').replaceAll('/', '_')
    ],
    ['non-zero pad bits', 'YR=='],
    ['not UTF-8', btoa('\xff\xfe synthetic')],
    ['not a string', 7],
    ['nested and not base64', { inner: 1 }]
  ]

  for (const [label, body] of uncheckable) {
    it(`refuses a bodyBase64 that is ${label} as uncheckable, with a constant entry`, () => {
      const emulator = makeR2Emulator()
      const reply = expectRefused(emulator, 'R2ObjectClient.put', putWith(body), 'uncheckable')

      expectConstant(emulator, reply, 'uncheckable-body', Predicate.isString(body) ? [body] : [])
    })
  }

  for (const [label, body] of [
    ['unpadded', utf8Base64(`synthetic ${secret}.`).replace(/=+$/, '')],
    ['line-wrapped', wrapped(utf8Base64(`synthetic ${secret}`), 4, '\r\n')],
    ['not UTF-8', btoa(`\xff${secret}`)]
  ] as const) {
    it(`refuses an ${label} body holding a credential as uncheckable, never echoing it`, () => {
      const emulator = makeR2Emulator()

      const reply = expectRefused(
        emulator,
        'R2ObjectClient.put',
        putWith(body, { secretAccessKey: secret }),
        'uncheckable'
      )

      expectConstant(emulator, reply, 'uncheckable-body', [secret, body.slice(0, 12)])
    })
  }

  it('checks a bodyBase64 at any depth, and drops one under a credential field', () => {
    const emulator = makeR2Emulator()

    expectRefused(
      emulator,
      'R2ObjectClient.put',
      putWith(String(putRequest.bodyBase64), { extra: [{ bodyBase64: 'YQ' }] }),
      'uncheckable'
    )
    // Under a credential field the whole value is dropped before any check: never decoded.
    expect(
      emulator.call('R2ObjectClient', 'get', {
        ...getRequest,
        credentials: { bodyBase64: 'not base64!' }
      })
    ).toEqual({ response: withinBudget.response })
    // Its key is guarded like its value: on a put, `bodyBase64` repeats the request's own key.
    expectRefused(
      emulator,
      'R2ObjectClient.put',
      ['R2ObjectClient', 'put', { ...putRequest, credentials: { bodyBase64: '<v>' } }],
      'credential'
    )
  })

  const tokenRequests: ReadonlyArray<readonly [string, Schema.JsonObject]> = [
    ['a bearer token in the key', { ...getRequest, key: `Bearer ${syntheticBearerToken}` }],
    [
      'a percent-encoded bearer token',
      {
        ...getRequest,
        key: encodeURIComponent(encodeURIComponent(`Bearer ${syntheticBearerToken}`))
      }
    ],
    ['a JSON-escaped bearer token', { ...getRequest, key: `Bearer\\u0020${syntheticBearerToken}` }],
    ['a bearer token as a key', { ...getRequest, [`bearer ${syntheticBearerToken}`]: 1 }],
    ...tokens.map(([label, token]): readonly [string, Schema.JsonObject] => [
      `an API-key-shaped value (${label})`,
      { ...getRequest, nested: [{ note: `x ${token}` }] }
    ]),
    ['an API key as a key', { ...getRequest, [awsKeySample]: true }],
    ['an escaped API key', { ...getRequest, key: awsKeySample.replace('A', '%41') }]
  ]

  for (const [label, request] of tokenRequests) {
    it(`refuses ${label} as credential-in-request, with constant text`, () => {
      const emulator = makeR2Emulator()

      const reply = expectRefused(
        emulator,
        'R2ObjectClient.get',
        ['R2ObjectClient', 'get', request],
        'credential'
      )

      expect(emulator.ledger.entries()[0]).toMatchObject({
        request: '<redacted>',
        reason: 'credential-in-request'
      })

      const text = observable(emulator, [reply])

      for (const form of [syntheticBearerToken, 'SYNTHETIC', 'synthetic-key', 'Bearer']) {
        expect(text, form).not.toContain(form)
      }
    })
  }
})

const seedWith = (...objects: R2EmulatorSeed['buckets'][number]['objects']): R2EmulatorSeed => ({
  buckets: [{ name: 'yolk-synthetic-bucket', objects }]
})

const seededObject = r2EmulatorDefaultSeed.buckets[0]?.objects[0] ?? expect.fail('no seeded object')

describe('R2 emulator: bucket state', () => {
  it('creates absent-only, refuses the second create, and reads the first bytes', () => {
    const emulator = makeR2Emulator()

    for (const step of ['create', 'create-again', 'read']) {
      const id = `objects.create-if-absent.${step}`

      expect(call(emulator, id), step).toEqual(answerOf(synthetic(id)))
    }

    expect(emulator.state()).toEqual(
      seedWith(seededObject, {
        key: String(putRequest.key),
        etag: '"c0ffee00c0ffee00c0ffee00c0ffee01"',
        bodyBase64: String(putRequest.bodyBase64)
      })
    )
  })

  it('replaces the bytes only under the current etag, with the etag the fixture names', () => {
    const emulator = makeR2Emulator()

    for (const step of ['create', 'stale', 'current', 'read']) {
      const id = `objects.update-if-match.${step}`

      expect(call(emulator, id), step).toEqual(answerOf(synthetic(id)))
    }

    const current = asObject(synthetic('objects.update-if-match.current').request)

    expect(emulator.state().buckets[0]?.objects.at(-1)).toEqual({
      key: String(current.key),
      etag: '"c0ffee00c0ffee00c0ffee00c0ffee03"',
      bodyBase64: String(current.bodyBase64)
    })
    // The current etag is now stale: the same update is refused, nothing changes.
    const after = emulator.state()

    expect(call(emulator, 'objects.update-if-match.current')).toEqual({
      notEmulated: { reason: reasons.conflict }
    })
    expect(emulator.state()).toEqual(after)
  })

  it('answers not_found only while the key is absent, and the object only as seeded', () => {
    const missing = synthetic('objects.get-missing-not-found.get')
    const missingKey = String(asObject(missing.request).key)

    const planted = makeR2Emulator({
      seed: seedWith(seededObject, { key: missingKey, etag: '"e1"', bodyBase64: btoa('x') })
    })

    expect(call(planted, 'objects.get-missing-not-found.get')).toEqual({
      notEmulated: { reason: reasons.conflict }
    })

    // Other bytes under the seeded key: the recorded object answer no longer holds.
    const changed = makeR2Emulator({
      seed: seedWith({ ...seededObject, bodyBase64: btoa('other synthetic bytes') })
    })

    expect(call(changed, 'objects.get-max-bytes.within-budget')).toEqual({
      notEmulated: { reason: reasons.conflict }
    })
    // A bucket the state does not hold answers nothing.
    expect(
      call(makeR2Emulator({ seed: { buckets: [] } }), 'objects.get-missing-not-found.get')
    ).toEqual({
      notEmulated: { reason: reasons.conflict }
    })
  })

  it('presigns whatever the bucket holds: presigning reads and writes nothing', () => {
    const emulator = makeR2Emulator({ seed: { buckets: [] } })

    expect(emulator.call('R2Presigner', 'presignPutObject', presign.request)).toEqual({
      response: presign.response
    })
    expect(emulator.state()).toEqual({ buckets: [] })
  })

  it('prefers fixtures not used since the last reset among equally consistent ones', () => {
    const emulator = makeR2Emulator()

    for (let index = 0; index < 3; index += 1) {
      emulator.call('R2ObjectClient', 'get', getRequest)
    }

    expect(emulator.ledger.entries().map(entry => entry.fixtureId)).toEqual([
      'r2.objects.get-max-bytes.within-budget.synthetic',
      'r2.objects.get-expected-etag.plain.synthetic',
      'r2.objects.get-max-bytes.within-budget.synthetic'
    ])
  })

  it('types every fixture as exactly one of response or failure', () => {
    const neither = { id: 'x', port: 'R2ObjectClient', method: 'get', request: {} }
    // @ts-expect-error a fixture needs a response or a failure
    const invalid: R2EmulatorFixture = neither

    expect(invalid).toBe(neither)
    expect(
      r2EmulatorFixtures.every(
        recorded => (recorded.response === undefined) !== (recorded.failure === undefined)
      )
    ).toBe(true)
  })
})

describe('R2 emulator: faults, reset, coverage', () => {
  it('answers matching calls with the fault failure, counts them, and writes nothing', () => {
    const emulator = makeR2Emulator()

    const added = emulator.faults.add({
      kind: 'failure',
      port: 'R2ObjectClient',
      method: 'put',
      match: { condition: { kind: 'absent' } },
      count: 1,
      failure
    })

    expect(added).toMatchObject({ id: 1, remaining: 1, applied: 0 })
    expect(call(emulator, 'objects.create-if-absent.create')).toEqual({ failure })
    expect(emulator.state()).toEqual(r2EmulatorDefaultSeed)
    // Exhausted after one call: the next matching call is answered from the fixtures.
    expect(call(emulator, 'objects.create-if-absent.create')).toHaveProperty('response')
    expect(emulator.faults.list()).toEqual([{ ...added, remaining: 0, applied: 1 }])
    expect(emulator.ledger.entries().map(entry => [entry.outcome, entry.faultId ?? null])).toEqual([
      ['fault', 1],
      ['answered', null]
    ])
  })

  it('matches faults as a deep subset of the credential-free request', () => {
    const emulator = makeR2Emulator()

    emulator.faults.add({
      kind: 'failure',
      port: 'R2ObjectClient',
      method: 'get',
      match: { maxBytes: 43 },
      failure
    })

    expect(emulator.call('R2ObjectClient', 'get', getRequest)).toHaveProperty('response')
    expect(call(emulator, 'objects.get-max-bytes.over-budget')).toEqual({ failure })
  })

  it('rejects invalid faults with R2EmulatorInputInvalid', () => {
    const emulator = makeR2Emulator()

    const invalid: ReadonlyArray<unknown> = [
      { kind: 'failure', port: 'R2ObjectClient', method: 'delete', failure },
      { kind: 'failure', port: 'R2Presigner', method: 'get', failure },
      { kind: 'failure', method: 'get', failure },
      { kind: 'failure', port: 'R2ObjectClient', method: 'get', failure, count: 0 },
      { kind: 'failure', port: 'R2ObjectClient', method: 'get', failure, extra: true },
      { kind: 'status', port: 'R2ObjectClient', method: 'get', failure },
      {
        kind: 'failure',
        port: 'R2ObjectClient',
        method: 'get',
        failure: { kind: 'defect', code: 'x', message: '' }
      }
    ]

    for (const input of invalid) {
      expect(() => emulator.faults.add(untyped<R2EmulatorFault>(input))).toThrow(
        R2EmulatorInputInvalid
      )
    }

    expect(emulator.faults.list()).toEqual([])
  })

  it('reset restores the seed and clears the ledger, faults, and fixture use', () => {
    const emulator = makeR2Emulator()

    emulator.faults.add({ kind: 'failure', port: 'R2ObjectClient', method: 'get', failure })
    call(emulator, 'objects.create-if-absent.create')
    emulator.reset()

    expect(emulator.state()).toEqual(r2EmulatorDefaultSeed)
    expect(emulator.ledger.entries()).toEqual([])
    expect(emulator.faults.list()).toEqual([])
    expect(emulator.coverage().unusedFixtureIds).toHaveLength(r2EmulatorFixtures.length)
  })

  it('reports calls per manifest route, refusals, and unused fixtures', () => {
    const emulator = makeR2Emulator()

    emulator.call('R2ObjectClient', 'get', getRequest)
    emulator.call('R2ObjectClient', 'list', {})

    const coverage = emulator.coverage()

    expect(coverage.routes.map(route => [route.path, route.calls])).toEqual(
      r2EmulatorRoutes.map(route => [route.path, route.path === 'R2ObjectClient.get' ? 1 : 0])
    )
    expect(coverage.notEmulatedCalls).toBe(1)
    expect(coverage.unusedFixtureIds).not.toContain(withinBudget.id)
    expect(coverage.unusedFixtureIds).toHaveLength(r2EmulatorFixtures.length - 1)

    emulator.ledger.clear()
    expect(emulator.ledger.entries()).toEqual([])
  })
})

describe('R2 emulator: seed', () => {
  it('defaults to the synthetic practice bucket and never shares state between emulators', () => {
    const first = makeR2Emulator()
    const second = makeR2Emulator()

    call(first, 'objects.create-if-absent.create')

    expect(second.state()).toEqual(r2EmulatorDefaultSeed)
    expect(first.seed()).toEqual(r2EmulatorDefaultSeed)
  })

  it('rejects invalid seeds', () => {
    const invalid: ReadonlyArray<unknown> = [
      {
        buckets: [
          { name: 'b', objects: [] },
          { name: 'b', objects: [] }
        ]
      },
      { buckets: [{ name: 'b', objects: [seededObject, seededObject] }] },
      { buckets: [{ name: 'b', objects: [{ ...seededObject, bodyBase64: 'not base64!' }] }] },
      { buckets: [{ name: 'b', objects: [{ ...seededObject, bodyBase64: 'YQ' }] }] },
      { buckets: [{ name: 'b', objects: [{ ...seededObject, size: 44 }] }] },
      { buckets: [{ name: '', objects: [] }] },
      { buckets: [], extra: true }
    ]

    for (const seed of invalid) {
      expect(() => makeR2Emulator({ seed: untyped<R2EmulatorSeed>(seed) })).toThrow(
        R2EmulatorInputInvalid
      )
    }
  })

  it('carries no credential field, signer, or S3 surface: only plain JSON', () => {
    expect(JSON.parse(JSON.stringify(r2EmulatorFixtures))).toEqual(r2EmulatorFixtures)
    expect(JSON.stringify(r2EmulatorFixtures)).not.toMatch(
      /"(?:accessKeyId|secretAccessKey|sessionToken|credentials?)"/
    )
  })
})
