// @vitest-environment node
import { afterEach, beforeEach, vi } from 'vitest'
import { assert, describe, expect, it } from '@effect/vitest'
import { ConfigProvider, Effect, Schema } from 'effect'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { getAuthTables } from 'better-auth/db'
import { getTableColumns } from 'drizzle-orm'
import * as schema from '../db/schema'
import { Auth } from './live-layer'

const makeAuth = Auth.pipe(
  Effect.provide(Auth.layer),
  Effect.provide(
    ConfigProvider.layer(
      ConfigProvider.fromEnv({
        env: {
          NODE_ENV: 'test',
          DATABASE_URL: 'postgresql://test:test@db.example.test/test',
          NEXT_PUBLIC_PROJECT_URL: 'http://localhost:3000',
          APP_NAME: 'Auth test',
          EMAIL_SENDER: 'auth@example.test',
          RESEND_API_KEY: 're_test'
        }
      })
    )
  )
)

beforeEach(() => {
  // Better Auth owns this synchronous SDK env boundary, not Effect Config.
  vi.stubEnv('BETTER_AUTH_SECRET', 'auth-test-only-9Ew4x7K2p8Q6z1V5m3R0s4T9')
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('Unexpected outbound request in auth test')))
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('installed Better Auth compatibility', () => {
  it.effect(
    'initializes the actual Drizzle-backed layer and reads an anonymous session without IO',
    () =>
      Effect.gen(function* () {
        const service = yield* makeAuth
        yield* Effect.promise(() => service.auth.$context)
        expect(yield* service.getSession()).toBeNull()
        expect(fetch).not.toHaveBeenCalled()
      })
  )

  it.effect('fits the existing auth columns without an issuer migration', () =>
    Effect.gen(function* () {
      const service = yield* makeAuth
      const tables = getAuthTables(service.auth.options)

      const columns = {
        user: getTableColumns(schema.user),
        session: getTableColumns(schema.session),
        account: getTableColumns(schema.account),
        verification: getTableColumns(schema.verification)
      }

      expect(Object.keys(tables).sort()).toEqual(Object.keys(columns).sort())

      for (const [name, modelColumns] of Object.entries(columns)) {
        const table = tables[name]
        assert(table)

        for (const [key, field] of Object.entries(table.fields)) {
          expect(modelColumns, `${name}.${key}`).toHaveProperty(field.fieldName ?? key)
        }
      }

      expect(tables.account?.fields).not.toHaveProperty('issuer')
      expect(fetch).not.toHaveBeenCalled()
    })
  )

  it.effect(
    'roundtrips OTP and signed session cookies with the actual options and an in-memory adapter',
    () =>
      Effect.gen(function* () {
        const service = yield* makeAuth

        // Retain the app's plugins, user fields, origins, and cookie settings;
        // replace only persistence. The Drizzle adapter is checked separately above.
        const auth = betterAuth({
          ...service.auth.options,
          database: memoryAdapter({ user: [], session: [], account: [], verification: [] })
        })

        let otp = ''
        vi.stubGlobal(
          'fetch',
          vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init)
            expect(request.url).toBe('https://api.resend.com/emails')

            const payload = await Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Struct({ html: Schema.String }))
            )(await request.text()).pipe(Effect.runPromise)

            otp = payload.html.match(/<strong>([0-9]{6})<\/strong>/)?.[1] ?? ''

            return Response.json({ id: 'email_test' })
          })
        )

        yield* Effect.promise(() =>
          auth.api.sendVerificationOTP({
            body: { email: 'user@example.test', type: 'sign-in' }
          })
        )
        expect(otp).toMatch(/^[0-9]{6}$/)

        const response = yield* Effect.promise(() =>
          auth.api.signInEmailOTP({
            body: { email: 'user@example.test', otp, name: 'Test user' },
            asResponse: true
          })
        )

        expect(response.status).toBe(200)
        const cookies = response.headers.getSetCookie()
        expect(cookies.some(cookie => cookie.startsWith('better-auth.session_token='))).toBe(true)

        const session = yield* Effect.promise(() =>
          auth.api.getSession({
            headers: new Headers({ cookie: cookies.map(cookie => cookie.split(';')[0]).join('; ') })
          })
        )

        expect(session?.user).toMatchObject({
          email: 'user@example.test',
          emailVerified: true,
          name: 'Test user',
          role: 'USER'
        })
        expect(fetch).toHaveBeenCalledTimes(1)
      })
  )
})
