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

type E2eServer =
  | {
      readonly kind: 'portless'
      readonly baseURL: string
      readonly command: string
    }
  | {
      readonly kind: 'port'
      readonly baseURL: string
      readonly command: string
    }

const getPort = (envName: string, defaultValue: string) => {
  const value = process.env[envName] ?? defaultValue
  const parsed = Number.parseInt(value, 10)

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535 || String(parsed) !== value) {
    throw new Error(`Invalid ${envName} for Playwright: ${value}`)
  }

  return value
}

const getPortlessName = () => {
  const value = process.env.E2E_PORTLESS_NAME ?? 'yolk-e2e'

  if (!/^[a-z0-9.-]+$/.test(value)) {
    throw new Error(`Invalid E2E_PORTLESS_NAME for Playwright: ${value}`)
  }

  return value
}

const getE2eServer = (): E2eServer => {
  if (process.env.CI || process.env.PORTLESS === '0') {
    const port = getPort('E2E_PORT', '3007')

    return {
      kind: 'port',
      baseURL: `http://localhost:${port}`,
      command: `NODE_ENV=test pnpm next dev --port ${port}`
    }
  }

  const name = getPortlessName()
  const proxyPort = getPort('E2E_PORTLESS_PROXY_PORT', '1355')

  return {
    kind: 'portless',
    baseURL: process.env.E2E_BASE_URL ?? `http://${name}.localhost:${proxyPort}`,
    command: `NODE_ENV=test PORTLESS_HTTPS=0 PORTLESS_PORT=${proxyPort} PORTLESS_SYNC_HOSTS=0 pnpm exec portless run --name ${name} pnpm run dev:app`
  }
}

const e2eServer = getE2eServer()

export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',

  webServer: {
    command: e2eServer.command,
    url: e2eServer.baseURL,
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
    baseURL: e2eServer.baseURL,
    ignoreHTTPSErrors: e2eServer.kind === 'portless',
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
})
