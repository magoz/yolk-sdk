import './lib/dotenv'
import { defineConfig, devices } from '@playwright/test'

const PORT = process.env.PORT || 3000
const baseURL = `http://localhost:${PORT}`

export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',

  webServer: {
    command: 'NODE_ENV=test pnpm next dev',
    url: baseURL,
    timeout: 120 * 1000,
    reuseExistingServer: !process.env.CI
  },

  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
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
