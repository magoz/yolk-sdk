import { and, desc, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { AppSearchIndexStoreError } from './errors'
import type { AppKnowledgeDocumentRecord } from './document-records'

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

    return rows satisfies ReadonlyArray<AppKnowledgeDocumentRecord>
  }).pipe(
    Effect.withSpan('knowledge_search.documents.get'),
    Effect.mapError(
      error =>
        new AppSearchIndexStoreError({
          message: 'Could not get knowledge search documents',
          cause: error
        })
    )
  )
