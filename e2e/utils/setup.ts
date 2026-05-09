import { Effect } from 'effect'
import { Db } from '@/lib/services/db/live-layer'
import type { User, InsertUser } from '@/lib/services/db/schema'
import { createTestUser } from './create-test-user'
import { ensureTestEnvironment } from './ensure-test-environment'

export type TestData = {
  user: User
}

export const createTestSetup = (input?: { user?: Partial<InsertUser> }) => {
  ensureTestEnvironment('Create Test Setup')

  return Effect.gen(function* () {
    const user = yield* createTestUser(input?.user)
    return { user }
  }).pipe(Effect.provide(Db.layer), Effect.scoped)
}
