import { and, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { AppRagDocumentNotFoundError, AppRagStoreError, isAppRagDocumentNotFoundError } from './errors'
import type { AppRagDocumentRecord } from './document-records'

const mapStoreError = (error: unknown) => {
  if (isAppRagDocumentNotFoundError(error)) {
    return error
  }

  return new AppRagStoreError({ message: 'Could not get RAG document', cause: error })
}

export const getRagDocument = (input: { readonly userId: string; readonly documentId: string }) =>
  Effect.gen(function* () {
    const db = yield* Db
    const [row] = yield* db
      .select({ document: schema.ragDocument, storageObject: schema.storageObject })
      .from(schema.ragDocument)
      .innerJoin(schema.storageObject, eq(schema.storageObject.id, schema.ragDocument.storageObjectId))
      .where(
        and(eq(schema.ragDocument.id, input.documentId), eq(schema.storageObject.userId, input.userId))
      )

    if (row === undefined) {
      return yield* Effect.fail(
        new AppRagDocumentNotFoundError({ message: 'RAG document not found', documentId: input.documentId })
      )
    }

    return row satisfies AppRagDocumentRecord
  }).pipe(Effect.withSpan('rag.document.get'), Effect.mapError(mapStoreError))
