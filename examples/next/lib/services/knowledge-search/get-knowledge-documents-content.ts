import { and, asc, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { AppSearchIndexStoreError } from './errors'
import type { AppKnowledgeDocumentWithContent } from './document-records'

type AccumulatedDocument = {
  readonly document: schema.KnowledgeDocument
  readonly storageRecord: schema.StorageObject
  readonly chunks: Array<string>
}

export const getKnowledgeDocumentsContent = (input: {
  readonly userId: string
  readonly collectionId: string
}) =>
  Effect.gen(function* () {
    const db = yield* Db
    const rows = yield* db
      .select({
        document: schema.knowledgeDocument,
        storageRecord: schema.storageObject,
        chunkContent: schema.knowledgeChunk.content
      })
      .from(schema.knowledgeDocument)
      .innerJoin(
        schema.storageObject,
        eq(schema.storageObject.id, schema.knowledgeDocument.storageObjectId)
      )
      .leftJoin(
        schema.knowledgeChunk,
        eq(schema.knowledgeChunk.documentId, schema.knowledgeDocument.id)
      )
      .where(
        and(
          eq(schema.knowledgeDocument.collectionId, input.collectionId),
          eq(schema.storageObject.userId, input.userId)
        )
      )
      .orderBy(asc(schema.knowledgeDocument.createdAt), asc(schema.knowledgeChunk.position))

    const documents = new Map<string, AccumulatedDocument>()

    for (const row of rows) {
      const existing = documents.get(row.document.id)
      if (existing !== undefined) {
        if (row.chunkContent !== null) {
          existing.chunks.push(row.chunkContent)
        }
        continue
      }

      documents.set(row.document.id, {
        document: row.document,
        storageRecord: row.storageRecord,
        chunks: row.chunkContent === null ? [] : [row.chunkContent]
      })
    }

    return Array.from(documents.values()).map(item => ({
      document: item.document,
      storageRecord: item.storageRecord,
      content: item.chunks.join('\n\n')
    })) satisfies ReadonlyArray<AppKnowledgeDocumentWithContent>
  }).pipe(
    Effect.withSpan('knowledge_search.documents.getContent'),
    Effect.mapError(
      error =>
        new AppSearchIndexStoreError({
          message: 'Could not get knowledge search document content',
          cause: error
        })
    )
  )
