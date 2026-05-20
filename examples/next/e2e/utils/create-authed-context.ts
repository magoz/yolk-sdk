import type { Browser, BrowserContext } from '@playwright/test'
import { authSessionCookieName } from './auth-cookie'

/**
 * Create a BrowserContext with a better-auth session cookie for the given signed token.
 *
 * Use this for tests that need multiple authenticated users in the same spec.
 * The token must already be HMAC-SHA256 signed (from `createTestAuthSession`).
 */
export async function createAuthedContext(
  browser: Browser,
  signedToken: string,
  baseURL = 'http://localhost'
): Promise<BrowserContext> {
  const appUrl = new URL(baseURL)
  const context = await browser.newContext()
  await context.addCookies([
    {
      name: authSessionCookieName(appUrl),
      value: signedToken,
      domain: appUrl.hostname,
      path: '/',
      httpOnly: true,
      secure: appUrl.protocol === 'https:',
      sameSite: 'Lax'
    }
  ])
  return context
}
