import { Effect } from 'effect'
import { createId } from '@paralleldrive/cuid2'
import { Db } from '@/lib/services/db/live-layer'
import { user, type InsertUser } from '@/lib/services/db/schema'
import { ensureTestEnvironment } from './ensure-test-environment'

export const createTestUser = (input?: Partial<InsertUser>) => {
  ensureTestEnvironment('Create Test User')

  return Effect.gen(function* () {
    const db = yield* Db

    const results = yield* db
      .insert(user)
      .values({
        id: createId(),
        name: `Test User ${createId().slice(0, 6)}`,
        email: `test-${createId()}@example.com`,
        emailVerified: true,
        ...input
      })
      .returning()

    return results[0]
  })
}
