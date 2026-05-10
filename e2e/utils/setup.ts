import { Effect } from 'effect'
import type { User, InsertUser } from '@/lib/services/db/schema'
import { createTestUser } from './create-test-user'
import { ensureTestEnv } from './ensure-test-env'
import { TestDbLayer } from './test-db'

export type TestData = {
  user: User
}

export const createTestSetup = (input?: { user?: Partial<InsertUser> }) =>
  Effect.gen(function* () {
    yield* ensureTestEnv('Create Test Setup')
    const user = yield* createTestUser(input?.user)
    return { user }
  }).pipe(Effect.provide(TestDbLayer), Effect.scoped)
