import { describe, expect, it } from '@effect/vitest'
import { scanFixtureForSecrets } from '@yolk-sdk/conformance/fixture'
import { isCredentialHeaderName, redactCredentialQuery } from '../src/emulator-http.ts'

// A synthetic fixture whose only possible finding is a credential-named request header.
const conformanceCallsCredential = (name: string): boolean =>
  scanFixtureForSecrets({
    id: 'synthetic.credential-rule',
    caseId: 'synthetic.credential-rule',
    evidence: 'unverified',
    recordedAt: '2026-09-30',
    account: 'synthetic',
    endpoint: 'https://example.test/',
    exchanges: [
      {
        request: {
          method: 'GET',
          url: 'https://example.test/',
          headers: { [name]: 'synthetic' }
        },
        response: { status: 200, headers: {}, body: '' }
      }
    ]
  }).some(issue => issue.kind === 'credential_header')

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

  it('redacts credential-named query keys only', () => {
    expect(
      redactCredentialQuery(new URLSearchParams('$top=2&access_token=s&code_verifier=v&x=1'))
    ).toEqual({ $top: '2', access_token: '<redacted>', code_verifier: 'v', x: '1' })
  })
})
