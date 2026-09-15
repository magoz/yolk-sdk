import { DateTime, Effect } from 'effect'
import type * as Schema from 'effect/Schema'
import type { KnowledgeDocument, KnowledgeFile } from '@yolk-sdk/knowledge/documents'
import { KnowledgeStoreError } from '@yolk-sdk/knowledge/errors'
import type * as dbSchema from '@/lib/services/db/schema'
import {
  decodePersistedJsonObject,
  persistedJsonObjectErrorMessage
} from '@/lib/services/db/persisted-json-object'

const toDateTime = (date: Date) => DateTime.fromDateUnsafe(date)

const metadataError = (error: Schema.SchemaError) =>
  new KnowledgeStoreError({
    message: persistedJsonObjectErrorMessage(error),
    cause: error
  })

export const knowledgeDocumentFromRow = (input: {
  readonly document: typeof dbSchema.userKnowledgeDocument.$inferSelect
}): Effect.Effect<KnowledgeDocument, KnowledgeStoreError> =>
  decodePersistedJsonObject(input.document.metadata).pipe(
    Effect.map(metadata => ({
      id: input.document.id,
      slug: input.document.slug,
      title: input.document.title,
      purpose: input.document.purpose,
      origin: input.document.origin,
      content: input.document.content,
      status: input.document.status,
      availability: input.document.availability,
      summary: input.document.summary ?? undefined,
      errorMessage: input.document.errorMessage ?? undefined,
      reviewedAt:
        input.document.reviewedAt === null ? undefined : toDateTime(input.document.reviewedAt),
      metadata,
      createdAt: toDateTime(input.document.createdAt),
      updatedAt: toDateTime(input.document.updatedAt)
    })),
    Effect.mapError(metadataError)
  )

export const knowledgeFileFromRow = (
  row: typeof dbSchema.userKnowledgeFile.$inferSelect
): Effect.Effect<KnowledgeFile, KnowledgeStoreError> =>
  decodePersistedJsonObject(row.metadata).pipe(
    Effect.map(metadata => ({
      id: row.id,
      documentId: row.documentId,
      storageKey: row.storageKey,
      mediaType: row.mediaType ?? undefined,
      byteSize: row.byteSize ?? undefined,
      checksum: row.checksum ?? undefined,
      metadata,
      createdAt: toDateTime(row.createdAt)
    })),
    Effect.mapError(metadataError)
  )
