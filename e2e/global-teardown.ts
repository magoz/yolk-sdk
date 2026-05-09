import '../lib/dotenv'
import { Effect } from 'effect'
import { sql } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

// All tables from the schema — order doesn't matter (TRUNCATE CASCADE)
const tables = [schema.user, schema.session, schema.account, schema.verification]

/**
 * Global teardown runs once after all Playwright tests.
 * Truncates all tables so the test DB doesn't accumulate stale rows between runs.
 */
const globalTeardown = async () => {
  await Effect.gen(function* () {
    const db = yield* Db

    const tableNames = tables.map(table => {
      const tableConfig = getTableConfig(table)
      const schemaName = tableConfig.schema ?? 'public'
      return `"${schemaName}"."${tableConfig.name}"`
    })

    yield* db.execute(sql.raw(`TRUNCATE ${tableNames.join(', ')} CASCADE`))
    yield* Effect.log('Teardown complete')
  }).pipe(Effect.provide(Db.layer), Effect.scoped, Effect.runPromise)
}

export default globalTeardown
