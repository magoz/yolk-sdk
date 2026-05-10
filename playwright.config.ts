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

const getE2ePort = () => {
  const value = process.env.E2E_PORT ?? '3007'
  const parsed = Number.parseInt(value, 10)

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535 || String(parsed) !== value) {
    throw new Error(`Invalid E2E_PORT for Playwright: ${value}`)
  }

  return value
}

const PORT = getE2ePort()
const baseURL = `http://localhost:${PORT}`

export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',

  webServer: {
    command: `NODE_ENV=test pnpm next dev --port ${PORT}`,
    url: baseURL,
    timeout: 120 * 1000,
    reuseExistingServer: !process.env.CI
  },

  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL,
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
})
