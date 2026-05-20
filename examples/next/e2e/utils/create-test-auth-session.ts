import { Effect, Config } from 'effect'
import { createId } from '@paralleldrive/cuid2'
import { createHmac } from 'node:crypto'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { ensureTestEnv } from './ensure-test-env'


/**
 * Sign a cookie value the same way better-call does internally.
 * Uses HMAC-SHA256 with standard base64 encoding (NOT base64url).
 * Result is URL-encoded.
 *
 * @see https://github.com/bekacru/better-call/blob/main/packages/better-call/src/crypto.ts
 */
function signCookieValue(value: string, secret: string): string {
  const signature = createHmac('sha256', secret).update(value).digest('base64')
  return encodeURIComponent(`${value}.${signature}`)
}

/**
 * Create a better-auth session directly in the database.
 * Returns the HMAC-signed session token ready for cookie injection.
 *
 * Bypasses the auth flow entirely — no OTP, no social provider.
 * The token is signed with BETTER_AUTH_SECRET so the app accepts it as valid.
 */
export const createTestAuthSession = (userId: string) =>
  Effect.gen(function* () {
    yield* ensureTestEnv('Create Test Auth Session')
    const db = yield* Db
    const secret = yield* Config.string('BETTER_AUTH_SECRET')

    const token = createId()
    const now = new Date()

    const [session] = yield* db
      .insert(schema.session)
      .values({
        id: createId(),
        token,
        userId,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days
        createdAt: now,
        updatedAt: now
      })
      .returning()

    if (session === undefined) {
      return yield* Effect.die(new Error('Failed to create auth session'))
    }

    const signedToken = signCookieValue(token, secret)
    return { session, token: signedToken }
  })
