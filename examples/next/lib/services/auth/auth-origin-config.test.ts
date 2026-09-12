// @vitest-environment node
import { ConfigProvider, Effect } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import { getAuthOriginConfig } from './auth-origin-config'

const getConfig = (env: Record<string, string>) =>
  getAuthOriginConfig().pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))))

describe('auth origin config', () => {
  it.effect('uses the exact Portless origin over stale copied app/deployment URLs', () =>
    Effect.gen(function* () {
      const config = yield* getConfig({
        NODE_ENV: 'development',
        PORTLESS_URL: 'https://feature.yolk.dev.example.com:1355/',
        NEXT_PUBLIC_PROJECT_URL: 'https://app.example.com',
        VERCEL_URL: 'deployment.vercel.app',
        VERCEL_BRANCH_URL: 'branch.vercel.app'
      })
      expect(config).toEqual({
        baseURL: 'https://feature.yolk.dev.example.com:1355',
        trustedOrigins: ['https://feature.yolk.dev.example.com:1355']
      })
    })
  )

  it.effect('does not require a static project URL under Portless', () =>
    Effect.gen(function* () {
      const config = yield* getConfig({
        NODE_ENV: 'development',
        PORTLESS_URL: 'https://yolk.localhost'
      })
      expect(config.baseURL).toBe('https://yolk.localhost')
    })
  )

  it.effect('preserves deployed auth and ignores injected Portless values in production', () =>
    Effect.gen(function* () {
      const config = yield* getConfig({
        NODE_ENV: 'production',
        PORTLESS_URL: 'https://untrusted.example.com',
        NEXT_PUBLIC_PROJECT_URL: 'https://app.example.com',
        VERCEL_URL: 'deployment.vercel.app',
        VERCEL_BRANCH_URL: 'branch.vercel.app'
      })
      expect(config).toEqual({
        baseURL: 'https://deployment.vercel.app',
        trustedOrigins: [
          'https://app.example.com',
          'https://branch.vercel.app',
          'https://deployment.vercel.app'
        ]
      })
    })
  )

  it.effect('preserves the fixed-port E2E origin even when the shell has Portless set', () =>
    Effect.gen(function* () {
      const config = yield* getConfig({
        NODE_ENV: 'test',
        PORTLESS_URL: 'https://feature.yolk.localhost',
        NEXT_PUBLIC_PROJECT_URL: 'http://localhost:41773'
      })
      expect(config).toEqual({
        baseURL: 'http://localhost:41773',
        trustedOrigins: ['http://localhost:41773']
      })
    })
  )

  it.effect('preserves the explicit fallback for direct Next development', () =>
    Effect.gen(function* () {
      const config = yield* getConfig({
        NODE_ENV: 'development',
        NEXT_PUBLIC_PROJECT_URL: 'http://localhost:3000',
        VERCEL_URL: '',
        VERCEL_BRANCH_URL: ''
      })
      expect(config).toEqual({
        baseURL: 'http://localhost:3000',
        trustedOrigins: ['http://localhost:3000']
      })
    })
  )

  it.effect('fails closed on an invalid Portless URL without leaking it', () =>
    Effect.gen(function* () {
      const result = yield* getConfig({
        NODE_ENV: 'development',
        PORTLESS_URL: 'https://user:secret@yolk.localhost',
        NEXT_PUBLIC_PROJECT_URL: 'https://app.example.com'
      }).pipe(Effect.flip)
      expect(result._tag).toBe('AuthConfigError')
      expect(result.message).not.toContain('secret')
    })
  )

  it.effect('still requires configured origins outside development', () =>
    Effect.gen(function* () {
      const result = yield* getConfig({ PORTLESS_URL: 'https://yolk.localhost' }).pipe(Effect.flip)
      expect(result._tag).toBe('AuthConfigError')
    })
  )
})
