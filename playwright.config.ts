import './lib/dotenv'
import { defineConfig, devices } from '@playwright/test'

const requiredEnv = [
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'NEXT_PUBLIC_POSTHOG_KEY',
  'NEXT_PUBLIC_SENTRY_DSN'
]

const missingEnv = requiredEnv.filter(
  key => process.env[key] === undefined || process.env[key] === ''
)

if (missingEnv.length > 0) {
  throw new Error(
    `Missing E2E env vars: ${missingEnv.join(', ')}. Create .env.test or export them.`
  )
}

const getFixedPort = (envName: string, defaultValue: string) => {
  const value = process.env[envName] ?? defaultValue
  const parsed = Number.parseInt(value, 10)

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535 || String(parsed) !== value) {
    throw new Error(`Invalid ${envName} for Playwright: ${value}`)
  }

  return value
}

const port = getFixedPort('E2E_PORT', '41773')
const baseURL = `http://localhost:${port}`

export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',

  webServer: {
    command: `NODE_ENV=test pnpm next dev --port ${port}`,
    url: baseURL,
    timeout: 120 * 1000,
    reuseExistingServer: false
  },

  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL,
    ignoreHTTPSErrors: false,
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
})
