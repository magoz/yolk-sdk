import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import {
  KnowledgeDocumentId,
  KnowledgeScopeId,
  type KnowledgeChunk,
  type IndexedKnowledgeDocument
} from '@yolk-sdk/knowledge/documents'
import { SearchIndexStoreError } from '@yolk-sdk/knowledge/errors'
import type * as dbSchema from '@/lib/services/db/schema'
import {
  decodePersistedJsonObject,
  persistedJsonObjectErrorMessage
} from '@/lib/services/db/persisted-json-object'
import { knowledgeSourceFromStorageRow } from './storage-source'

const metadataError = (error: Schema.SchemaError) =>
  new SearchIndexStoreError({
    message: persistedJsonObjectErrorMessage(error),
    cause: error
  })

const idError = (error: Schema.SchemaError) =>
  new SearchIndexStoreError({ message: 'Invalid knowledge search id', cause: error })

export type IndexedDocumentRow = Pick<
  typeof dbSchema.knowledgeDocument.$inferSelect,
  | 'id'
  | 'collectionId'
  | 'status'
  | 'title'
  | 'summary'
  | 'errorMessage'
  | 'contentHash'
  | 'tokenCount'
  | 'chunkCount'
  | 'metadata'
>

export type IndexedChunkRow = Pick<
  typeof dbSchema.knowledgeChunk.$inferSelect,
  'id' | 'collectionId' | 'documentId' | 'content' | 'position' | 'tokenCount' | 'metadata'
>

export const toKnowledgeDocument = (input: {
  readonly document: IndexedDocumentRow
  readonly storage: Pick<
    typeof dbSchema.storageObject.$inferSelect,
    'id' | 'sourceType' | 'r2Key' | 'url' | 'filename' | 'mediaType'
  >
}): Effect.Effect<IndexedKnowledgeDocument, SearchIndexStoreError> =>
  Effect.gen(function* () {
    const source = yield* knowledgeSourceFromStorageRow({
      id: input.storage.id,
      sourceType: input.storage.sourceType,
      r2Key: input.storage.r2Key,
      url: input.storage.url,
      filename: input.storage.filename,
      mediaType: input.storage.mediaType
    })

    const id = yield* Schema.decodeUnknownEffect(KnowledgeDocumentId)(input.document.id).pipe(
      Effect.mapError(idError)
    )

    const scopeId = yield* Schema.decodeUnknownEffect(KnowledgeScopeId)(
      input.document.collectionId
    ).pipe(Effect.mapError(idError))

    const metadata = yield* decodePersistedJsonObject(input.document.metadata).pipe(
      Effect.mapError(metadataError)
    )

    return {
      id,
      scopeId,
      source,
      status: input.document.status,
      title: input.document.title ?? undefined,
      summary: input.document.summary ?? undefined,
      errorMessage: input.document.errorMessage ?? undefined,
      contentHash: input.document.contentHash ?? undefined,
      tokenCount: input.document.tokenCount,
      chunkCount: input.document.chunkCount,
      metadata
    }
  })

export const toKnowledgeChunk = (
  row: IndexedChunkRow
): Effect.Effect<KnowledgeChunk, SearchIndexStoreError> =>
  Effect.gen(function* () {
    const scopeId = yield* Schema.decodeUnknownEffect(KnowledgeScopeId)(row.collectionId).pipe(
      Effect.mapError(idError)
    )

    const documentId = yield* Schema.decodeUnknownEffect(KnowledgeDocumentId)(row.documentId).pipe(
      Effect.mapError(idError)
    )

    const metadata = yield* decodePersistedJsonObject(row.metadata).pipe(
      Effect.mapError(metadataError)
    )

    return {
      id: row.id,
      scopeId,
      documentId,
      content: row.content,
      position: row.position,
      tokenCount: row.tokenCount,
      metadata
    }
  })
