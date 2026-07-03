import { Effect } from 'effect'
import { createId } from '@paralleldrive/cuid2'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import type { InsertUser } from '@/lib/services/db/schema'
import { ensureTestEnv } from './ensure-test-env'

export const createTestUser = (input?: Partial<InsertUser>) =>
  Effect.gen(function* () {
    yield* ensureTestEnv('Create Test User')
    const db = yield* Db

    const [createdUser] = yield* db
      .insert(schema.user)
      .values({
        id: createId(),
        name: `Test User ${createId().slice(0, 6)}`,
        email: `test-${createId()}@example.com`,
        emailVerified: true,
        ...input
      })
      .returning()

    if (createdUser === undefined) {
      return yield* Effect.die(new Error('Failed to create test user'))
    }

    return createdUser
  })
