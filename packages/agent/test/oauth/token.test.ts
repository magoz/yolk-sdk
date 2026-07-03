import { describe, expect, it } from 'vitest'
import {
  OAuthAccessToken,
  isTokenFresh,
  shouldRefreshToken,
  tokenRemainingTtlMs
} from '../../src/oauth/index.ts'

describe('OAuth token TTL helpers', () => {
  it('checks freshness against caller minimum TTL', () => {
    const token = new OAuthAccessToken({
      provider: 'provider',
      accessToken: 'access',
      expiresAt: 1_500
    })

    expect(tokenRemainingTtlMs(token, 1_000)).toBe(500)
    expect(isTokenFresh(token, 1_000, 500)).toBe(true)
    expect(shouldRefreshToken(token, 1_000, 501)).toBe(true)
  })
})
