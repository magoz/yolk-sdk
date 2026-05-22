import { eq, sql } from 'drizzle-orm'
import { Effect } from 'effect'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import {
  AppKnowledgeDocumentNotFoundError,
  AppSearchIndexStoreError,
  isAppKnowledgeDocumentNotFoundError,
  isAppSearchIndexStoreError
} from './errors'
import { getKnowledgeDocument } from './get-knowledge-document'

export type UpdateKnowledgeDocumentFields = {
  readonly title?: string | null
  readonly summary?: string | null
  readonly metadata?: Record<string, unknown>
}

export type UpdateKnowledgeDocumentInput = {
  readonly userId: string
  readonly documentId: string
  readonly fields: UpdateKnowledgeDocumentFields
}

const mapUpdateError = (error: unknown) => {
  if (isAppKnowledgeDocumentNotFoundError(error) || isAppSearchIndexStoreError(error)) {
    return error
  }

  return new AppSearchIndexStoreError({ message: 'Could not update knowledge search document', cause: error })
}

const documentPatch = (fields: UpdateKnowledgeDocumentFields) => ({
  updatedAt: sql`CURRENT_TIMESTAMP`,
  ...(fields.title !== undefined ? { title: fields.title } : {}),
  ...(fields.summary !== undefined ? { summary: fields.summary } : {}),
  ...(fields.metadata !== undefined ? { metadata: fields.metadata } : {})
})

export const updateKnowledgeDocument = (input: UpdateKnowledgeDocumentInput) =>
  Effect.gen(function* () {
    yield* getKnowledgeDocument({ userId: input.userId, documentId: input.documentId })

    const db = yield* Db
    const [document] = yield* db
      .update(schema.knowledgeDocument)
      .set(documentPatch(input.fields))
      .where(eq(schema.knowledgeDocument.id, input.documentId))
      .returning({ id: schema.knowledgeDocument.id })

    if (document === undefined) {
      return yield* Effect.fail(
        new AppKnowledgeDocumentNotFoundError({
          message: 'knowledge search document not found',
          documentId: input.documentId
        })
      )
    }

    return yield* getKnowledgeDocument({ userId: input.userId, documentId: document.id })
  }).pipe(Effect.withSpan('knowledge_search.document.update'), Effect.mapError(mapUpdateError))
