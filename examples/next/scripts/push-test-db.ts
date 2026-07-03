import '../lib/dotenv'
import { neon } from '@neondatabase/serverless'
import { spawnSync } from 'node:child_process'

const DATABASE_URL = process.env.DATABASE_URL

if (process.env.NODE_ENV !== 'test') {
  throw new Error('Refusing to reset database outside NODE_ENV=test')
}

if (DATABASE_URL === undefined || DATABASE_URL.length === 0) {
  console.log('No test DATABASE_URL; skipping test DB push')
  process.exit(0)
}

const sql = neon(DATABASE_URL)

await sql`DROP SCHEMA IF EXISTS public CASCADE`
await sql`CREATE SCHEMA public`

const setupResult = spawnSync('pnpm', ['db:setup'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'test' }
})

if (setupResult.error !== undefined) throw setupResult.error

if (setupResult.status !== 0) {
  process.exitCode = setupResult.status ?? 1
  process.exit()
}

const pushResult = spawnSync('drizzle-kit', ['push', '--config', 'drizzle.config.ts', '--force'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'test' }
})

if (pushResult.error !== undefined) throw pushResult.error

process.exitCode = pushResult.status ?? 1
