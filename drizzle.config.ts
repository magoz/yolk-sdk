import './lib/dotenv'
import { defineConfig } from 'drizzle-kit'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) throw new Error('DATABASE_URL env variable not found')

export default defineConfig({
  schema: './lib/services/db/schema.ts',
  out: './lib/services/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: DATABASE_URL
  }
})
