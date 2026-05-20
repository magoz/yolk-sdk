import { Db } from '@/lib/services/db/live-layer'

/**
 * Drizzle Db layer for E2E test utilities.
 *
 * Reads DATABASE_URL from `.env.test` via centralized `lib/dotenv` loading.
 */
export const TestDbLayer = Db.layer
