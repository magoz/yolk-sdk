import { and, eq, sql } from 'drizzle-orm'
import { Effect } from 'effect'
import { PersistenceError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { encodePersistedMetadata } from './encode-persisted-metadata'

const DEFAULT_STORAGE_COLLECTION_LABEL = 'storage'

export const ensureUserKnowledgeCollection = (input: { readonly userId: string }) =>
  Effect.gen(function* () {
    const db = yield* Db

    const [existing] = yield* db
      .select()
      .from(schema.knowledgeCollection)
      .where(
        and(
          eq(schema.knowledgeCollection.userId, input.userId),
          eq(schema.knowledgeCollection.label, DEFAULT_STORAGE_COLLECTION_LABEL)
        )
      )

    if (existing !== undefined) {
      return existing
    }

    const metadata = yield* encodePersistedMetadata({
      value: { purpose: 'storage', userId: input.userId },
      entity: 'knowledgeCollection'
    })

    const [created] = yield* db
      .insert(schema.knowledgeCollection)
      .values({
        userId: input.userId,
        label: DEFAULT_STORAGE_COLLECTION_LABEL,
        metadata
      })
      .onConflictDoUpdate({
        target: [schema.knowledgeCollection.userId, schema.knowledgeCollection.label],
        set: { updatedAt: sql`CURRENT_TIMESTAMP` }
      })
      .returning()

    if (created !== undefined) {
      return created
    }

    const [afterConflict] = yield* db
      .select()
      .from(schema.knowledgeCollection)
      .where(
        and(
          eq(schema.knowledgeCollection.userId, input.userId),
          eq(schema.knowledgeCollection.label, DEFAULT_STORAGE_COLLECTION_LABEL)
        )
      )

    if (afterConflict === undefined) {
      return yield* Effect.fail(
        new PersistenceError({
          message: 'Could not create storage knowledge collection',
          entity: 'knowledgeCollection'
        })
      )
    }

    return afterConflict
  }).pipe(Effect.withSpan('storage.ensureUserKnowledgeCollection'))
