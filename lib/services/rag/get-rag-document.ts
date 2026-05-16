import { eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { AppRagDocumentNotFoundError, AppRagStoreError } from './errors'
import type { AppRagDocumentRecord } from './document-records'

const mapStoreError = (error: unknown) => {
  if (error instanceof AppRagDocumentNotFoundError) {
    return error
  }

  return new AppRagStoreError({ message: 'Could not get RAG document', cause: error })
}

export const getRagDocument = (documentId: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const [row] = yield* db
      .select({ document: schema.ragDocument, storageObject: schema.storageObject })
      .from(schema.ragDocument)
      .innerJoin(schema.storageObject, eq(schema.storageObject.id, schema.ragDocument.storageObjectId))
      .where(eq(schema.ragDocument.id, documentId))

    if (row === undefined) {
      return yield* Effect.fail(
        new AppRagDocumentNotFoundError({ message: 'RAG document not found', documentId })
      )
    }

    return row satisfies AppRagDocumentRecord
  }).pipe(Effect.withSpan('rag.document.get'), Effect.mapError(mapStoreError))
