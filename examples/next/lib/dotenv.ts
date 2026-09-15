import dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const appEnv = (fileName: string) => join(dirname(fileURLToPath(import.meta.url)), '..', fileName)

if (process.env.NODE_ENV === 'test') {
  const testEnv = dotenv.config({ path: appEnv('.env.test'), override: true, quiet: true }).parsed

  // Schema resets recreate enum OIDs. Avoid pooler-cached prepared statements,
  // using only this test file's URL, never an inherited development credential.
  const unpooledUrl = testEnv?.DATABASE_URL_UNPOOLED

  if (unpooledUrl !== undefined && unpooledUrl.length > 0) {
    process.env.DATABASE_URL = unpooledUrl
  }
} else {
  dotenv.config({ path: appEnv('.env.local'), quiet: true })
  dotenv.config({ path: appEnv('.env'), quiet: true })
}
