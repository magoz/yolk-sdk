import { describe, expect, it } from '@effect/vitest'
import { scanFixtureForSecrets } from '@yolk-sdk/conformance/fixture'
import {
  isCredentialHeaderName,
  isCredentialQueryKey,
  redactCredentialQuery
} from '../src/emulator-http.ts'

// A synthetic fixture with one GET request: its only possible finding is `kind`.
const conformanceFinds = (
  kind: 'credential_header' | 'credential_query_param',
  request: { readonly url: string; readonly headers: Readonly<Record<string, string>> }
): boolean =>
  scanFixtureForSecrets({
    id: 'synthetic.credential-rule',
    caseId: 'synthetic.credential-rule',
    evidence: 'unverified',
    recordedAt: '2026-09-30',
    account: 'synthetic',
    endpoint: 'https://example.test/',
    exchanges: [
      {
        request: { method: 'GET', ...request },
        response: { status: 200, headers: {}, body: '' }
      }
    ]
  }).some(issue => issue.kind === kind)

// A credential-named request header.
const conformanceCallsCredential = (name: string): boolean =>
  conformanceFinds('credential_header', {
    url: 'https://example.test/',
    headers: { [name]: 'synthetic' }
  })

// A credential query parameter.
const conformanceCallsCredentialQuery = (name: string): boolean =>
  conformanceFinds('credential_query_param', {
    url: `https://example.test/?${encodeURIComponent(name)}=synthetic`,
    headers: {}
  })

describe('credential names', () => {
  // The emulators copy the conformance rule (their source never imports SDK packages); this
  // keeps the copy from drifting.
  it('agree with the @yolk-sdk/conformance rule', () => {
    const names = [
      'Authorization',
      'Proxy-Authorization',
      'Cookie',
      'Set-Cookie',
      'X-Api-Key',
      'api-key',
      'x-goog-api-key',
      'X-Auth-Token',
      'x-access-token',
      'x-amz-security-token',
      'x-vercel-oidc-token',
      'x-csrf-token',
      'access_token',
      'api_key',
      'apikey',
      'client_secret',
      'password',
      'private-token',
      'x-figma-token',
      'x-custom-key',
      'auth',
      'Prefer',
      'Accept',
      'Content-Type',
      'client-request-id',
      'x-ratelimit-remaining-tokens',
      'keyboard',
      'author',
      '$select',
      '$top',
      'startDateTime',
      '@microsoft.graph.conflictBehavior'
    ]

    const disagreements = names.filter(
      name => isCredentialHeaderName(name) !== conformanceCallsCredential(name)
    )

    expect(disagreements).toEqual([])
    // Both kinds are represented, so agreement is not vacuous.
    expect(names.filter(isCredentialHeaderName).length).toBeGreaterThan(10)
    expect(names.filter(name => !isCredentialHeaderName(name)).length).toBeGreaterThan(5)
  })

  // Every query parameter the conformance fixture scan reports (`credential_query_param`) is
  // redacted in emulator ledgers; the emulator rule may redact more (it also applies the header
  // rule), never less.
  it('redact every credential_query_param the @yolk-sdk/conformance scan reports', () => {
    const reported = [
      'api_key',
      'api-key',
      'apikey',
      'key',
      'token',
      'access_token',
      'access-token',
      'accesstoken',
      'refresh_token',
      'id_token',
      'auth',
      'secret',
      'password',
      'client_secret',
      'clientsecret',
      'X-Amz-Signature',
      'x-amz-signature',
      'X-Amz-Credential',
      'x-amz-credential',
      'X-Amz-Security-Token'
    ]

    const ignored = [
      '$select',
      '$top',
      '$skip',
      'startDateTime',
      'endDateTime',
      '@microsoft.graph.conflictBehavior',
      'code_verifier',
      'X-Amz-Algorithm',
      'X-Amz-Date',
      'X-Amz-Expires',
      'X-Amz-SignedHeaders',
      'keyboard',
      'author'
    ]

    // The fixture scan agrees on both lists, so the check below is not vacuous.
    expect(reported.filter(name => !conformanceCallsCredentialQuery(name))).toEqual([])
    expect(ignored.filter(conformanceCallsCredentialQuery)).toEqual([])

    const missed = [...reported, ...ignored].filter(
      name => conformanceCallsCredentialQuery(name) && !isCredentialQueryKey(name)
    )

    expect(missed).toEqual([])
    expect(ignored.filter(isCredentialQueryKey)).toEqual([])

    const query = new URLSearchParams(reported.map(name => [name, 'synthetic-secret']))

    expect(Object.values(redactCredentialQuery(query)).every(value => value === '<redacted>')).toBe(
      true
    )
  })

  it('redacts credential-named query keys only', () => {
    expect(
      redactCredentialQuery(new URLSearchParams('$top=2&access_token=s&code_verifier=v&x=1'))
    ).toEqual({ $top: '2', access_token: '<redacted>', code_verifier: 'v', x: '1' })
  })
})
