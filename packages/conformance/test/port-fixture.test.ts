import { Effect, Exit } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  conformanceFixtureEvidence,
  decodePortFixture,
  isPortCredentialKey,
  isPortFailureFixture,
  isPortFixture,
  redactPortPayload,
  scanPortFixtureForSecrets,
  syntheticPortCredentialParams,
  type PortFixture,
  type WireFixture
} from '../src/fixture.ts'

const valueFixture: PortFixture = {
  id: 'example.port.list.synthetic',
  port: 'ExampleClient',
  method: 'listItems',
  request: {
    connection: { protocol: 'example', host: 'mail.example.test' },
    folder: 'INBOX',
    limit: 50,
    max_tokens: 16
  },
  response: { items: [{ id: '1:1', subject: 'Synthetic tokens and passwords talk' }] },
  note: 'Synthetic placeholder about task-manager tokens.'
}

const failureFixture: PortFixture = {
  id: 'example.port.get.missing',
  port: 'ExampleClient',
  method: 'getItem',
  request: { id: '1:404' },
  failure: { kind: 'expected', code: 'not_found', message: 'No such item.', status: 404 },
  observed: { account: 'practice', date: '2026-09-28' }
}

const wireFixture: WireFixture = {
  id: 'example.wire.synthetic',
  caseId: 'example.wire.case',
  evidence: 'unverified',
  recordedAt: '2026-09-01',
  account: 'synthetic',
  endpoint: 'https://api.example.test',
  exchanges: [
    {
      request: { method: 'GET', url: 'https://api.example.test/items' },
      response: { status: 200, headers: {}, body: '[]' }
    }
  ]
}

describe('port fixture schema', () => {
  it.effect('decodes value and failure fixtures', () =>
    Effect.gen(function* () {
      expect(yield* decodePortFixture(valueFixture)).toEqual(valueFixture)
      expect(yield* decodePortFixture(failureFixture)).toEqual(failureFixture)
    })
  )

  it.effect('requires exactly one of response or failure, and valid metadata', () =>
    Effect.gen(function* () {
      const invalid: ReadonlyArray<unknown> = [
        { ...valueFixture, failure: { kind: 'expected', code: 'x', message: '' } },
        { id: 'example.port.none', port: 'ExampleClient', method: 'listItems', request: {} },
        { ...valueFixture, port: '' },
        { ...valueFixture, method: '' },
        { ...failureFixture, failure: { kind: 'defect', code: 'x', message: '' } },
        { ...failureFixture, failure: { kind: 'error', code: '', message: '' } },
        { ...failureFixture, observed: { account: 'practice', date: 'yesterday' } }
      ]

      for (const input of invalid) {
        expect(Exit.isFailure(yield* Effect.exit(decodePortFixture(input)))).toBe(true)
      }
    })
  )

  it('narrows port fixtures and failure fixtures', () => {
    expect(isPortFixture(valueFixture)).toBe(true)
    expect(isPortFixture(wireFixture)).toBe(false)
    expect(isPortFailureFixture(valueFixture)).toBe(false)
    expect(isPortFailureFixture(failureFixture)).toBe(true)
  })

  it('derives evidence: observed port fixtures are verified, others unverified without a date', () => {
    expect(conformanceFixtureEvidence(valueFixture)).toEqual({ evidence: 'unverified' })
    expect(conformanceFixtureEvidence(failureFixture)).toEqual({
      evidence: 'verified',
      date: '2026-09-28'
    })
    expect(conformanceFixtureEvidence(wireFixture)).toEqual({
      evidence: 'unverified',
      date: '2026-09-01'
    })
  })
})

describe('port payload redaction', () => {
  it('drops credential fields at any depth and keeps everything else', () => {
    expect(
      redactPortPayload({
        connection: { host: 'mail.example.test', port: 993 },
        credential: { _tag: 'UsernamePasswordCredential', username: 'ada', password: 'x' },
        sentCopy: { credential: { username: 'ada', password: 'x' }, folder: 'Sent' },
        items: [{ password: 'x', subject: 'kept' }],
        max_tokens: 16
      })
    ).toEqual({
      connection: { host: 'mail.example.test', port: 993 },
      sentCopy: { folder: 'Sent' },
      items: [{ subject: 'kept' }],
      max_tokens: 16
    })
  })

  it('classifies credential keys', () => {
    for (const key of [
      'credential',
      'Credentials',
      'password',
      'api_key',
      'accessToken',
      'token'
    ]) {
      expect(isPortCredentialKey(key)).toBe(true)
    }

    for (const key of ['connection', 'max_tokens', 'username', 'subject', 'credentialRef']) {
      expect(isPortCredentialKey(key)).toBe(false)
    }
  })

  it('drops AWS-style signing credentials in camelCase and snake_case', () => {
    const keys = [
      'accessKeyId',
      'AccessKeyId',
      'access_key_id',
      'secretAccessKey',
      'SecretAccessKey',
      'secret_access_key',
      'sessionToken',
      'SessionToken',
      'session_token'
    ]

    for (const key of keys) {
      expect(isPortCredentialKey(key)).toBe(true)
    }

    expect(
      redactPortPayload({
        endpoint: 'https://storage.example.test',
        ...Object.fromEntries(keys.map(key => [key, 'synthetic-value'])),
        bucket: 'kept',
        nested: [{ secret_access_key: 'x', key: 'kept/object.txt' }]
      })
    ).toEqual({
      endpoint: 'https://storage.example.test',
      bucket: 'kept',
      nested: [{ key: 'kept/object.txt' }]
    })

    for (const key of ['accessKey', 'bucket', 'key', 'contentType', 'etag']) {
      expect(isPortCredentialKey(key)).toBe(false)
    }
  })
})

describe('scanPortFixtureForSecrets', () => {
  it('passes clean fixtures, including plural usage fields and prose about tokens', () => {
    expect(scanPortFixtureForSecrets(valueFixture)).toEqual([])
    expect(scanPortFixtureForSecrets(failureFixture)).toEqual([])
  })

  it('flags credential objects, credential fields, and token patterns by location only', () => {
    const leaky: PortFixture = {
      ...valueFixture,
      id: 'example.port.leaky',
      note: 'Authorization: Bearer abcdefghijklmnop',
      request: {
        credential: { username: 'ada' },
        sentCopy: { credential: { username: 'ada', password: 'hunter2hunter2' } }
      },
      response: { items: [{ apiKey: 'sk-proj-abcdefghijklmnopqrstuvwxyz' }] }
    }

    const issues = scanPortFixtureForSecrets(leaky)

    expect(issues).toEqual(
      expect.arrayContaining([
        { kind: 'bearer_token', location: 'note' },
        { kind: 'credential_field', location: 'request.credential' },
        { kind: 'credential_field', location: 'request.sentCopy.credential' },
        { kind: 'credential_field', location: 'request.sentCopy.credential.password' },
        { kind: 'credential_field', location: 'response.items[0].apiKey' },
        { kind: 'api_key', location: 'response.items[0].apiKey' }
      ])
    )
    expect(JSON.stringify(issues)).not.toContain('hunter2')
    expect(JSON.stringify(issues)).not.toContain('abcdefghijklmnop')
  })

  it('flags credential query parameters inside JSON strings, notes, and failure messages', () => {
    const signed =
      'https://storage.example.test/bucket/key.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=LIVEKEYID%2F20260930%2Fauto%2Fs3%2Faws4_request&X-Amz-Signature=a1b2c3d4e5f6'

    expect(
      scanPortFixtureForSecrets({
        ...valueFixture,
        note: `recorded from ${signed}`,
        request: { links: [`?token=live-token-value`] },
        response: { uploadUrl: signed }
      })
    ).toEqual([
      { kind: 'credential_query_param', location: 'note' },
      { kind: 'credential_query_param', location: 'request.links[0]' },
      { kind: 'credential_query_param', location: 'response.uploadUrl' }
    ])
    expect(
      scanPortFixtureForSecrets({
        ...failureFixture,
        failure: { kind: 'error', code: 'transport_failed', message: `redirected to ${signed}` }
      })
    ).toEqual([{ kind: 'credential_query_param', location: 'failure.message' }])
    expect(
      scanPortFixtureForSecrets({
        ...valueFixture,
        response: { uploadUrl: signed.replace('&X-Amz-Signature', '&X-Amz-Security-Token=live&x') }
      })
    ).toEqual([{ kind: 'credential_query_param', location: 'response.uploadUrl' }])
  })

  const signature = syntheticPortCredentialParams['x-amz-signature']
  const credential = syntheticPortCredentialParams['x-amz-credential']
  const encodedCredential = encodeURIComponent(credential)
  const signedUrl = `https://storage.example.test/bucket/key.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${encodedCredential}&X-Amz-Signature=${signature}`
  const flaggedAt = (location: string) => [{ kind: 'credential_query_param', location }]

  const scanUploadUrl = (uploadUrl: string) =>
    scanPortFixtureForSecrets({ ...valueFixture, response: { uploadUrl } })

  it('accepts only the exact synthetic placeholders, under their own parameter names', () => {
    expect(Object.isFrozen(syntheticPortCredentialParams)).toBe(true)
    expect(Object.keys(syntheticPortCredentialParams)).toEqual([
      'x-amz-signature',
      'x-amz-credential'
    ])
    expect(scanUploadUrl(signedUrl)).toEqual([])
    // Parameter names match case-insensitively; values must match exactly after decoding.
    expect(scanUploadUrl(signedUrl.replace('X-Amz-Signature', 'x-amz-signature'))).toEqual([])
    // Prose that mentions a parameter without a query boundary is not a parameter.
    expect(
      scanPortFixtureForSecrets({
        ...valueFixture,
        response: { text: 'set the token= value in settings' }
      })
    ).toEqual([])
  })

  it('flags a placeholder with anything appended, raw or percent-encoded', () => {
    for (const uploadUrl of [
      signedUrl.replace(`X-Amz-Signature=${signature}`, `X-Amz-Signature=${signature}0123abcdef`),
      signedUrl.replace(
        `X-Amz-Signature=${signature}`,
        `X-Amz-Signature=${encodeURIComponent(signature)}%2Da1b2c3d4`
      ),
      signedUrl.replace(encodedCredential, `${encodedCredential}%2Fextra`),
      signedUrl.replace(encodedCredential, encodedCredential.replace('20260930', '20261001')),
      `${signedUrl}&api_key=synthetic`,
      `${signedUrl}&X-Amz-Security-Token=${signature}`
    ]) {
      expect(scanUploadUrl(uploadUrl), uploadUrl).toEqual(flaggedAt('response.uploadUrl'))
    }
  })

  it('judges every parameter on its own: a synthetic URL never hides a later live one', () => {
    for (const separator of [' ', '"', "'", '<', '>', ' then ', '\n']) {
      const text = `${signedUrl}${separator}https://storage.example.test/other?token=0123456789abcdef0123456789abcdef`

      expect(scanUploadUrl(text), JSON.stringify(separator)).toEqual(
        flaggedAt('response.uploadUrl')
      )
    }

    // A `?` inside a value ends it too, so the second query string is judged separately.
    expect(scanUploadUrl(`${signedUrl}?X-Amz-Signature=a1b2c3d4e5f6`)).toEqual(
      flaggedAt('response.uploadUrl')
    )
    expect(
      scanPortFixtureForSecrets({
        ...failureFixture,
        failure: {
          kind: 'error',
          code: 'transport_failed',
          message: `PUT ${signedUrl} failed; retried /bucket/key.txt?X-Amz-Signature=a1b2c3d4e5f6`
        }
      })
    ).toEqual(flaggedAt('failure.message'))
  })

  it('never exempts a placeholder under another parameter name, or a look-alike password', () => {
    for (const query of [
      `token=${signature}`,
      `X-Amz-Signature=${credential}`,
      `X-Amz-Security-Token=${signature}`,
      'password=yolk-synthetic-Hunter2!',
      'client_secret=yolk-synthetic-signature-plus'
    ]) {
      expect(scanUploadUrl(`https://storage.example.test/b/k?${query}`), query).toEqual(
        flaggedAt('response.uploadUrl')
      )
    }

    expect(
      scanPortFixtureForSecrets({
        ...valueFixture,
        note: 'password=yolk-synthetic-pw&username=ada'
      })
    ).toEqual(flaggedAt('note'))
  })

  it('scans failure messages and observation labels', () => {
    expect(
      scanPortFixtureForSecrets({
        ...failureFixture,
        failure: { kind: 'error', code: 'transport_failed', message: 'Bearer abcdefghijklmnop' },
        observed: { account: 'sk-abcdefghijklmnopqrstuv', date: '2026-09-28' }
      })
    ).toEqual([
      { kind: 'api_key', location: 'observed.account' },
      { kind: 'bearer_token', location: 'failure.message' }
    ])
  })
})
