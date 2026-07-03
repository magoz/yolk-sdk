import { and, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import {
  AppKnowledgeDocumentNotFoundError,
  AppSearchIndexStoreError,
  isAppKnowledgeDocumentNotFoundError
} from './errors'
import type { AppKnowledgeDocumentRecord } from './document-records'

const mapStoreError = (error: unknown) => {
  if (isAppKnowledgeDocumentNotFoundError(error)) {
    return error
  }

  return new AppSearchIndexStoreError({
    message: 'Could not get knowledge search document',
    cause: error
  })
}

export const getKnowledgeDocument = (input: {
  readonly userId: string
  readonly documentId: string
}) =>
  Effect.gen(function* () {
    const db = yield* Db
    const [row] = yield* db
      .select({ document: schema.knowledgeDocument, storageRecord: schema.storageObject })
      .from(schema.knowledgeDocument)
      .innerJoin(
        schema.storageObject,
        eq(schema.storageObject.id, schema.knowledgeDocument.storageObjectId)
      )
      .where(
        and(
          eq(schema.knowledgeDocument.id, input.documentId),
          eq(schema.storageObject.userId, input.userId)
        )
      )

    if (row === undefined) {
      return yield* Effect.fail(
        new AppKnowledgeDocumentNotFoundError({
          message: 'knowledge search document not found',
          documentId: input.documentId
        })
      )
    }

    return row satisfies AppKnowledgeDocumentRecord
  }).pipe(Effect.withSpan('knowledge_search.document.get'), Effect.mapError(mapStoreError))
