import dotenv from 'dotenv'

if (process.env.NODE_ENV === 'test') {
  dotenv.config({ path: '.env.test', quiet: true })
} else {
  dotenv.config({ path: '.env.local', quiet: true })
  dotenv.config({ path: '.env', quiet: true })
}
