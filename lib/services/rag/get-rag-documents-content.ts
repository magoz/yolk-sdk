import { asc, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { AppRagStoreError } from './errors'
import type { AppRagDocumentWithContent } from './document-records'

type AccumulatedDocument = {
  readonly document: schema.RagDocument
  readonly storageObject: schema.StorageObject
  readonly chunks: Array<string>
}

export const getRagDocumentsContent = (ragSetId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const rows = yield* db
      .select({
        document: schema.ragDocument,
        storageObject: schema.storageObject,
        chunkContent: schema.ragChunk.content
      })
      .from(schema.ragDocument)
      .innerJoin(schema.storageObject, eq(schema.storageObject.id, schema.ragDocument.storageObjectId))
      .leftJoin(schema.ragChunk, eq(schema.ragChunk.documentId, schema.ragDocument.id))
      .where(eq(schema.ragDocument.ragSetId, ragSetId))
      .orderBy(asc(schema.ragDocument.createdAt), asc(schema.ragChunk.position))

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
        storageObject: row.storageObject,
        chunks: row.chunkContent === null ? [] : [row.chunkContent]
      })
    }

    return Array.from(documents.values()).map(item => ({
      document: item.document,
      storageObject: item.storageObject,
      content: item.chunks.join('\n\n')
    })) satisfies ReadonlyArray<AppRagDocumentWithContent>
  }).pipe(
    Effect.withSpan('rag.documents.getContent'),
    Effect.mapError(error => new AppRagStoreError({ message: 'Could not get RAG document content', cause: error }))
  )
