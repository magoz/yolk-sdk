import { and, eq, sql } from 'drizzle-orm'
import { Effect } from 'effect'
import { PersistenceError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

const DEFAULT_STORAGE_RAG_SET_LABEL = 'storage'

export const ensureUserRagSet = (input: { readonly userId: string }) =>
  Effect.gen(function* () {
    const db = yield* Db
    const [existing] = yield* db
      .select()
      .from(schema.ragSet)
      .where(
        and(
          eq(schema.ragSet.userId, input.userId),
          eq(schema.ragSet.label, DEFAULT_STORAGE_RAG_SET_LABEL)
        )
      )

    if (existing !== undefined) {
      return existing
    }

    const [created] = yield* db
      .insert(schema.ragSet)
      .values({
        userId: input.userId,
        label: DEFAULT_STORAGE_RAG_SET_LABEL,
        metadata: { purpose: 'storage', userId: input.userId }
      })
      .onConflictDoUpdate({
        target: [schema.ragSet.userId, schema.ragSet.label],
        set: { updatedAt: sql`CURRENT_TIMESTAMP` }
      })
      .returning()

    if (created !== undefined) {
      return created
    }

    const [afterConflict] = yield* db
      .select()
      .from(schema.ragSet)
      .where(
        and(
          eq(schema.ragSet.userId, input.userId),
          eq(schema.ragSet.label, DEFAULT_STORAGE_RAG_SET_LABEL)
        )
      )

    if (afterConflict === undefined) {
      return yield* Effect.fail(
        new PersistenceError({ message: 'Could not create storage RAG set', entity: 'ragSet' })
      )
    }

    return afterConflict
  }).pipe(Effect.withSpan('storage.ensureUserRagSet'))
