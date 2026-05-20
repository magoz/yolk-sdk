import { Effect } from 'effect'
import { is, sql } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'

import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { ensureTestEnv } from './ensure-test-env'


/** Truncate every table in the Drizzle schema. */
export const cleanupTestData = Effect.gen(function* () {
  yield* ensureTestEnv('Cleanup Test Data')
  const db = yield* Db

  const pgTables = Object.entries(schema).flatMap(([, value]) =>
    is(value, PgTable) ? [value] : []
  )

  const tablesToTruncate = pgTables.map(table => {
    const config = getTableConfig(table)
    const schemaName = config.schema ?? 'public'
    return `"${schemaName}"."${config.name}"`
  })

  if (tablesToTruncate.length > 0) {
    yield* db.execute(sql.raw(`TRUNCATE ${tablesToTruncate.join(', ')} CASCADE`))
  }
})
