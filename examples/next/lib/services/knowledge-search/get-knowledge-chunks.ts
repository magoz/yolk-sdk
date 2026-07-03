import { and, asc, eq, inArray } from 'drizzle-orm'
import { Effect } from 'effect'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { AppSearchIndexStoreError } from './errors'
import type { AppKnowledgeChunkRecord } from './document-records'

export const getKnowledgeChunks = (input: {
  readonly userId: string
  readonly chunkIds: ReadonlyArray<string>
}) =>
  Effect.gen(function* () {
    if (input.chunkIds.length === 0) {
      return []
    }

    const db = yield* Db
    const rows = yield* db
      .select({
        chunk: schema.knowledgeChunk,
        document: schema.knowledgeDocument,
        storageRecord: schema.storageObject
      })
      .from(schema.knowledgeChunk)
      .innerJoin(
        schema.knowledgeDocument,
        eq(schema.knowledgeDocument.id, schema.knowledgeChunk.documentId)
      )
      .innerJoin(
        schema.storageObject,
        eq(schema.storageObject.id, schema.knowledgeDocument.storageObjectId)
      )
      .where(
        and(
          inArray(schema.knowledgeChunk.id, [...input.chunkIds]),
          eq(schema.storageObject.userId, input.userId)
        )
      )
      .orderBy(asc(schema.knowledgeChunk.documentId), asc(schema.knowledgeChunk.position))

    return rows satisfies ReadonlyArray<AppKnowledgeChunkRecord>
  }).pipe(
    Effect.withSpan('knowledge_search.chunks.get'),
    Effect.mapError(
      error =>
        new AppSearchIndexStoreError({
          message: 'Could not get knowledge search chunks',
          cause: error
        })
    )
  )
