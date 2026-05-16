import { and, asc, eq, inArray } from 'drizzle-orm'
import { Effect } from 'effect'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { AppRagStoreError } from './errors'
import type { AppRagChunkRecord } from './document-records'

export const getRagChunks = (input: {
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
        chunk: schema.ragChunk,
        document: schema.ragDocument,
        storageObject: schema.storageObject
      })
      .from(schema.ragChunk)
      .innerJoin(schema.ragDocument, eq(schema.ragDocument.id, schema.ragChunk.documentId))
      .innerJoin(schema.storageObject, eq(schema.storageObject.id, schema.ragDocument.storageObjectId))
      .where(
        and(inArray(schema.ragChunk.id, [...input.chunkIds]), eq(schema.storageObject.userId, input.userId))
      )
      .orderBy(asc(schema.ragChunk.documentId), asc(schema.ragChunk.position))

    return rows satisfies ReadonlyArray<AppRagChunkRecord>
  }).pipe(
    Effect.withSpan('rag.chunks.get'),
    Effect.mapError(error => new AppRagStoreError({ message: 'Could not get RAG chunks', cause: error }))
  )
