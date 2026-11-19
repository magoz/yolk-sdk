import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // The Cloudflare runtime imports workerd's `cloudflare:workers`; tests use a stub with an
    // `env` they fill with fake bindings.
    alias: {
      'cloudflare:workers': fileURLToPath(
        new URL('./test/cloudflare-workers-stub.ts', import.meta.url)
      )
    }
  },
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.workflow-vitest/**',
      '**/*.integration.test.ts'
    ]
  }
})
