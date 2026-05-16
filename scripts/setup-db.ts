import '@/lib/dotenv'
import { neon } from '@neondatabase/serverless'

const DATABASE_URL = process.env.DATABASE_URL

if (DATABASE_URL === undefined || DATABASE_URL.length === 0) {
  throw new Error('DATABASE_URL env variable not found')
}

const sql = neon(DATABASE_URL)

const main = async () => {
  await sql`CREATE EXTENSION IF NOT EXISTS vector`

  console.log('Database extensions ready')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
