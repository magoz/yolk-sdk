/* eslint-disable react-hooks/rules-of-hooks -- Playwright fixture, not React */

import {
  test as base,
  type BrowserContext,
  type Page,
  type APIRequestContext
} from '@playwright/test'

type WorkerFixtures = {
  /** Playwright BrowserContext with better-auth session cookie injected */
  authedContext: BrowserContext
  /** Page from authedContext — ready to navigate to any authenticated route */
  authedPage: Page
}

type TestFixtures = {
  apiContext: APIRequestContext
}

/**
 * Extended Playwright test with authenticated browser context.
 *
 * Session cookie is created in global-setup (HMAC-SHA256 signed, same as
 * better-auth internals) and shared via TEST_SESSION_TOKEN env var.
 */
export const test = base.extend<TestFixtures, WorkerFixtures>({
  authedContext: [
    async ({ browser }, use) => {
      const token = process.env.TEST_SESSION_TOKEN
      if (!token) {
        throw new Error('TEST_SESSION_TOKEN not set. Did global-setup run?')
      }

      const context = await browser.newContext()
      await context.addCookies([
        {
          name: 'better-auth.session_token',
          value: token,
          domain: 'localhost',
          path: '/',
          httpOnly: true,
          secure: false,
          sameSite: 'Lax'
        }
      ])

      await use(context)
      await context.close()
    },
    { scope: 'worker' }
  ],

  authedPage: [
    async ({ authedContext }, use) => {
      const page = await authedContext.newPage()
      await use(page)
      await page.close()
    },
    { scope: 'worker' }
  ],

  // Test fixture - runs for each test
  apiContext: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({
      baseURL: `http://localhost:${process.env.PORT || 3000}`,
      extraHTTPHeaders: {
        Accept: 'application/json'
      }
    })
    await use(context)
    await context.dispose()
  }
})

export { expect } from '@playwright/test'
