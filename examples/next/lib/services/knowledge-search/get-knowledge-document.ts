import { and, eq } from 'drizzle-orm'
import type { EffectDrizzleQueryError } from 'drizzle-orm/effect-core'
import { Effect } from 'effect'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { AppKnowledgeDocumentNotFoundError, AppSearchIndexStoreError } from './errors'
import { decodeAppKnowledgeDocumentRecord } from './document-records'

const sqlStoreError = (error: EffectDrizzleQueryError) =>
  new AppSearchIndexStoreError({
    message: 'Could not get knowledge search document',
    cause: error
  })

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

    return yield* decodeAppKnowledgeDocumentRecord(row)
  }).pipe(
    Effect.withSpan('knowledge_search.document.get'),
    Effect.catchTag('EffectDrizzleQueryError', error => Effect.fail(sqlStoreError(error)))
  )
