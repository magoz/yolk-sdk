import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // `./cloudflare` imports workerd's `cloudflare:workers`; Node tests use a stub.
    alias: {
      'cloudflare:workers': fileURLToPath(
        new URL('./test/cloudflare-workers-stub.ts', import.meta.url)
      )
    }
  }
})
