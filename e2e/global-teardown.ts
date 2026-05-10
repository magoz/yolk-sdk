import '../lib/dotenv'
import { Effect } from 'effect'
import { cleanupTestData } from './utils/cleanup'
import { TestDbLayer } from './utils/test-db'

/**
 * Global teardown runs once after all Playwright tests.
 * Truncates all tables so the test DB doesn't accumulate stale rows between runs.
 */
const globalTeardown = async () => {
  await Effect.gen(function* () {
    yield* cleanupTestData
    yield* Effect.log('Teardown complete')
  }).pipe(Effect.provide(TestDbLayer), Effect.scoped, Effect.runPromise)
}

export default globalTeardown
