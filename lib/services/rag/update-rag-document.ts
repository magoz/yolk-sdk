import { eq, sql } from 'drizzle-orm'
import { Effect } from 'effect'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import {
  AppRagDocumentNotFoundError,
  AppRagStoreError,
  isAppRagDocumentNotFoundError,
  isAppRagStoreError
} from './errors'
import { getRagDocument } from './get-rag-document'

export type UpdateRagDocumentFields = {
  readonly title?: string | null
  readonly summary?: string | null
  readonly metadata?: Record<string, unknown>
}

export type UpdateRagDocumentInput = {
  readonly userId: string
  readonly documentId: string
  readonly fields: UpdateRagDocumentFields
}

const mapUpdateError = (error: unknown) => {
  if (isAppRagDocumentNotFoundError(error) || isAppRagStoreError(error)) {
    return error
  }

  return new AppRagStoreError({ message: 'Could not update RAG document', cause: error })
}

const documentPatch = (fields: UpdateRagDocumentFields) => ({
  updatedAt: sql`CURRENT_TIMESTAMP`,
  ...(fields.title !== undefined ? { title: fields.title } : {}),
  ...(fields.summary !== undefined ? { summary: fields.summary } : {}),
  ...(fields.metadata !== undefined ? { metadata: fields.metadata } : {})
})

export const updateRagDocument = (input: UpdateRagDocumentInput) =>
  Effect.gen(function* () {
    yield* getRagDocument({ userId: input.userId, documentId: input.documentId })

    const db = yield* Db
    const [document] = yield* db
      .update(schema.ragDocument)
      .set(documentPatch(input.fields))
      .where(eq(schema.ragDocument.id, input.documentId))
      .returning({ id: schema.ragDocument.id })

    if (document === undefined) {
      return yield* Effect.fail(
        new AppRagDocumentNotFoundError({
          message: 'RAG document not found',
          documentId: input.documentId
        })
      )
    }

    return yield* getRagDocument({ userId: input.userId, documentId: document.id })
  }).pipe(Effect.withSpan('rag.document.update'), Effect.mapError(mapUpdateError))
