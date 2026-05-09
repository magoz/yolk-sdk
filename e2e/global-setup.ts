import '../lib/dotenv'
import { Effect } from 'effect'
import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import { reset } from 'drizzle-seed'

import * as schema from '@/lib/services/db/schema'
import { Db } from '@/lib/services/db/live-layer'
import { createTestAuthSession } from './utils/create-test-auth-session'
import { TEST_USER_ID } from './test-ids'

/**
 * Global setup runs once before all Playwright tests.
 *
 * 1. Resets database via drizzle-seed (truncate + reseed)
 * 2. Seeds shared test data: user → auth session
 * 3. Shares signed session token via process.env for test workers
 */
const globalSetup = async () => {
  console.log('🧹 Resetting database...')

  // Reset DB via drizzle-seed (direct connection — not Effect-wrapped)
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl === undefined) {
    throw new Error('DATABASE_URL is required')
  }

  const sql = neon(databaseUrl)
  const db = drizzle({ client: sql, relations: schema.relations })
  await reset(db, schema)

  console.log('✅ Database reset complete')

  // Seed shared test data and create auth session
  const token = await Effect.gen(function* () {
    const effectDb = yield* Db

    console.log('👤 Creating test user...')
    const [user] = yield* effectDb
      .insert(schema.user)
      .values({
        id: TEST_USER_ID,
        name: 'E2E Test User',
        email: 'e2e-test@example.com',
        emailVerified: true
      })
      .returning()

    console.log('🔐 Creating auth session...')
    const { token } = yield* createTestAuthSession(user.id)

    console.log(`✅ Setup complete — user: ${user.email}`)
    return token
  }).pipe(Effect.provide(Db.layer), Effect.scoped, Effect.runPromise)

  // Share session token with test workers via env
  process.env.TEST_SESSION_TOKEN = token
}

export default globalSetup
