import { and, desc, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { AppSearchIndexStoreError, isAppSearchIndexStoreError } from './errors'
import { decodeAppKnowledgeDocumentRecord } from './document-records'

export const getKnowledgeDocuments = (input: {
  readonly userId: string
  readonly collectionId: string
}) =>
  Effect.gen(function* () {
    const db = yield* Db

    const rows = yield* db
      .select({ document: schema.knowledgeDocument, storageRecord: schema.storageObject })
      .from(schema.knowledgeDocument)
      .innerJoin(
        schema.storageObject,
        eq(schema.storageObject.id, schema.knowledgeDocument.storageObjectId)
      )
      .where(
        and(
          eq(schema.knowledgeDocument.collectionId, input.collectionId),
          eq(schema.storageObject.userId, input.userId)
        )
      )
      .orderBy(desc(schema.knowledgeDocument.createdAt))

    return yield* Effect.forEach(rows, decodeAppKnowledgeDocumentRecord)
  }).pipe(
    Effect.withSpan('knowledge_search.documents.get'),
    Effect.mapError(error =>
      isAppSearchIndexStoreError(error)
        ? error
        : new AppSearchIndexStoreError({
            message: 'Could not get knowledge search documents',
            cause: error
          })
    )
  )
