import '../lib/dotenv'
import { spawnSync } from 'node:child_process'

if (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL.length === 0) {
  console.log('No test DATABASE_URL; skipping test DB push')
  process.exit(0)
}

const result = spawnSync('pnpm', ['db:push'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'test' }
})

if (result.error !== undefined) {
  throw result.error
}

process.exitCode = result.status ?? 1
