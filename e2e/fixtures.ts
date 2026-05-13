/* eslint-disable react-hooks/rules-of-hooks -- Playwright fixture, not React */

import {
  test as base,
  type BrowserContext,
  type Page,
  type APIRequestContext
} from '@playwright/test'

type TestFixtures = {
  /** Playwright BrowserContext with better-auth session cookie injected */
  authedContext: BrowserContext
  /** Page from authedContext — ready to navigate to any authenticated route */
  authedPage: Page
  apiContext: APIRequestContext
}

/**
 * Extended Playwright test with authenticated browser context.
 *
 * Session cookie is created in global-setup (HMAC-SHA256 signed, same as
 * better-auth internals) and shared via TEST_SESSION_TOKEN env var.
 *
 * Fixtures are test-scoped so each test gets an isolated browser context.
 */
export const test = base.extend<TestFixtures>({
  authedContext: async ({ browser, baseURL }, use) => {
    const token = process.env.TEST_SESSION_TOKEN
    if (!token) {
      throw new Error('TEST_SESSION_TOKEN not set. Did global-setup run?')
    }
    if (baseURL === undefined) {
      throw new Error('baseURL not configured')
    }

    const appUrl = new URL(baseURL)

    const context = await browser.newContext()
    await context.addCookies([
      {
        name: 'better-auth.session_token',
        value: token,
        domain: appUrl.hostname,
        path: '/',
        httpOnly: true,
        secure: appUrl.protocol === 'https:',
        sameSite: 'Lax'
      }
    ])

    await use(context)
    await context.close()
  },

  authedPage: async ({ authedContext }, use) => {
    const page = await authedContext.newPage()
    await use(page)
    await page.close()
  },

  // Test fixture - runs for each test
  apiContext: async ({ playwright, baseURL }, use) => {
    if (baseURL === undefined) {
      throw new Error('baseURL not configured')
    }

    const appUrl = new URL(baseURL)

    const context = await playwright.request.newContext({
      baseURL,
      ignoreHTTPSErrors: appUrl.protocol === 'https:',
      extraHTTPHeaders: {
        Accept: 'application/json'
      }
    })
    await use(context)
    await context.dispose()
  }
})

export { expect } from '@playwright/test'
