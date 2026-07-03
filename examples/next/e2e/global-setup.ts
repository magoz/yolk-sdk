import '@/lib/dotenv'
import { Config, Effect } from 'effect'
import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import { reset } from 'drizzle-seed'

import * as schema from '@/lib/services/db/schema'
import { Db } from '@/lib/services/db/live-layer'
import { createTestAuthSession } from './utils/create-test-auth-session'
import { ensureTestEnv } from './utils/ensure-test-env'
import { TestDbLayer } from './utils/test-db'
import { TEST_USER_ID } from './test-ids'

/**
 * Global setup runs once before all Playwright tests.
 *
 * 1. Resets database via drizzle-seed (truncate + reseed)
 * 2. Seeds shared test data: user → auth session
 * 3. Shares signed session token via process.env for test workers
 */
const globalSetup = async () => {
  const token = await Effect.gen(function* () {
    yield* ensureTestEnv('Global Setup')

    yield* Effect.log('Resetting database')
    const databaseUrl = yield* Config.string('DATABASE_URL')
    const sql = neon(databaseUrl)
    const resetDb = drizzle({ client: sql, relations: schema.relations })

    yield* Effect.tryPromise({
      try: () => reset(resetDb, schema),
      catch: cause => new Error('Failed to reset database', { cause })
    })
    yield* Effect.log('Database reset complete')

    // Seed shared test data and create auth session
    const effectDb = yield* Db

    yield* Effect.log('Creating test user')
    const [user] = yield* effectDb
      .insert(schema.user)
      .values({
        id: TEST_USER_ID,
        name: 'E2E Test User',
        email: 'e2e-test@example.com',
        emailVerified: true
      })
      .returning()

    if (user === undefined) {
      return yield* Effect.die(new Error('Failed to create test user'))
    }

    yield* Effect.log('Creating auth session')
    const { token } = yield* createTestAuthSession(user.id)

    yield* Effect.log(`Setup complete — user: ${user.email}`)
    return token
  }).pipe(Effect.provide(TestDbLayer), Effect.scoped, Effect.runPromise)

  // Share session token with test workers via env
  process.env.TEST_SESSION_TOKEN = token
}

export default globalSetup
