import dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'

const rootEnv = (fileName: string) => fileURLToPath(new URL(`../../../${fileName}`, import.meta.url))

if (process.env.NODE_ENV === 'test') {
  dotenv.config({ path: rootEnv('.env.test'), override: true, quiet: true })
} else {
  dotenv.config({ path: rootEnv('.env.local'), quiet: true })
  dotenv.config({ path: rootEnv('.env'), quiet: true })
}
