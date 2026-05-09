import type { Browser, BrowserContext } from '@playwright/test'

/**
 * Create a BrowserContext with a better-auth session cookie for the given signed token.
 *
 * Use this for tests that need multiple authenticated users in the same spec.
 * The token must already be HMAC-SHA256 signed (from `createTestAuthSession`).
 */
export async function createAuthedContext(
  browser: Browser,
  signedToken: string
): Promise<BrowserContext> {
  const context = await browser.newContext()
  await context.addCookies([
    {
      name: 'better-auth.session_token',
      value: signedToken,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax'
    }
  ])
  return context
}
