import dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'

const appEnv = (fileName: string) => fileURLToPath(new URL(`../${fileName}`, import.meta.url))

if (process.env.NODE_ENV === 'test') {
  dotenv.config({ path: appEnv('.env.test'), override: true, quiet: true })
} else {
  dotenv.config({ path: appEnv('.env.local'), quiet: true })
  dotenv.config({ path: appEnv('.env'), quiet: true })
}
