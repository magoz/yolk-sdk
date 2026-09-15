import { DateTime, Effect } from 'effect'
import * as Schema from 'effect/Schema'
import {
  KnowledgeDocumentId,
  type KnowledgeDocument,
  type KnowledgeFile
} from '@yolk-sdk/knowledge/documents'
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

const documentIdError = (error: Schema.SchemaError) =>
  new KnowledgeStoreError({ message: 'Invalid knowledge document id', cause: error })

export const knowledgeDocumentFromRow = (input: {
  readonly document: typeof dbSchema.userKnowledgeDocument.$inferSelect
}): Effect.Effect<KnowledgeDocument, KnowledgeStoreError> =>
  Effect.gen(function* () {
    const id = yield* Schema.decodeUnknownEffect(KnowledgeDocumentId)(input.document.id).pipe(
      Effect.mapError(documentIdError)
    )

    const metadata = yield* decodePersistedJsonObject(input.document.metadata).pipe(
      Effect.mapError(metadataError)
    )

    return {
      id,
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
    }
  })

export const knowledgeFileFromRow = (
  row: typeof dbSchema.userKnowledgeFile.$inferSelect
): Effect.Effect<KnowledgeFile, KnowledgeStoreError> =>
  Effect.gen(function* () {
    const documentId = yield* Schema.decodeUnknownEffect(KnowledgeDocumentId)(row.documentId).pipe(
      Effect.mapError(documentIdError)
    )

    const metadata = yield* decodePersistedJsonObject(row.metadata).pipe(
      Effect.mapError(metadataError)
    )

    return {
      id: row.id,
      documentId,
      storageKey: row.storageKey,
      mediaType: row.mediaType ?? undefined,
      byteSize: row.byteSize ?? undefined,
      checksum: row.checksum ?? undefined,
      metadata,
      createdAt: toDateTime(row.createdAt)
    }
  })
