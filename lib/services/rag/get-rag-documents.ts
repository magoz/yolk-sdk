import { and, desc, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { AppRagStoreError } from './errors'
import type { AppRagDocumentRecord } from './document-records'

export const getRagDocuments = (input: { readonly userId: string; readonly ragSetId: string }) =>
  Effect.gen(function* () {
    const db = yield* Db
    const rows = yield* db
      .select({ document: schema.ragDocument, storageObject: schema.storageObject })
      .from(schema.ragDocument)
      .innerJoin(schema.storageObject, eq(schema.storageObject.id, schema.ragDocument.storageObjectId))
      .where(
        and(eq(schema.ragDocument.ragSetId, input.ragSetId), eq(schema.storageObject.userId, input.userId))
      )
      .orderBy(desc(schema.ragDocument.createdAt))

    return rows satisfies ReadonlyArray<AppRagDocumentRecord>
  }).pipe(
    Effect.withSpan('rag.documents.get'),
    Effect.mapError(error => new AppRagStoreError({ message: 'Could not get RAG documents', cause: error }))
  )
