import { Effect } from 'effect'
import type * as Schema from 'effect/Schema'
import type * as schema from '@/lib/services/db/schema'
import {
  decodePersistedJsonObject,
  persistedJsonObjectErrorMessage,
  type PersistedJsonObject
} from '@/lib/services/db/persisted-json-object'
import { AppSearchIndexStoreError } from './errors'

export type AppKnowledgeDocumentRecord = {
  readonly document: Omit<schema.KnowledgeDocument, 'metadata'> & {
    readonly metadata: PersistedJsonObject
  }
  readonly storageRecord: Omit<schema.StorageObject, 'metadata'> & {
    readonly metadata: PersistedJsonObject
  }
}

export type AppKnowledgeDocumentWithContent = AppKnowledgeDocumentRecord & {
  readonly content: string
}

export type AppKnowledgeChunkRecord = {
  readonly chunk: Omit<schema.KnowledgeChunk, 'metadata'> & {
    readonly metadata: PersistedJsonObject
  }
  readonly document: Omit<schema.KnowledgeDocument, 'metadata'> & {
    readonly metadata: PersistedJsonObject
  }
  readonly storageRecord: Omit<schema.StorageObject, 'metadata'> & {
    readonly metadata: PersistedJsonObject
  }
}

const appMetadataError = (error: Schema.SchemaError) =>
  new AppSearchIndexStoreError({
    message: persistedJsonObjectErrorMessage(error),
    cause: error
  })

export const decodeAppKnowledgeDocumentRecord = (row: {
  readonly document: schema.KnowledgeDocument
  readonly storageRecord: schema.StorageObject
}): Effect.Effect<AppKnowledgeDocumentRecord, AppSearchIndexStoreError> =>
  Effect.gen(function* () {
    const metadata = yield* decodePersistedJsonObject(row.document.metadata).pipe(
      Effect.mapError(appMetadataError)
    )

    const storageMetadata = yield* decodePersistedJsonObject(row.storageRecord.metadata).pipe(
      Effect.mapError(appMetadataError)
    )

    return {
      document: { ...row.document, metadata },
      storageRecord: { ...row.storageRecord, metadata: storageMetadata }
    }
  })

export const decodeAppKnowledgeChunkRecord = (row: {
  readonly chunk: schema.KnowledgeChunk
  readonly document: schema.KnowledgeDocument
  readonly storageRecord: schema.StorageObject
}): Effect.Effect<AppKnowledgeChunkRecord, AppSearchIndexStoreError> =>
  Effect.gen(function* () {
    const chunkMetadata = yield* decodePersistedJsonObject(row.chunk.metadata).pipe(
      Effect.mapError(appMetadataError)
    )

    const metadata = yield* decodePersistedJsonObject(row.document.metadata).pipe(
      Effect.mapError(appMetadataError)
    )

    const storageMetadata = yield* decodePersistedJsonObject(row.storageRecord.metadata).pipe(
      Effect.mapError(appMetadataError)
    )

    return {
      chunk: { ...row.chunk, metadata: chunkMetadata },
      document: { ...row.document, metadata },
      storageRecord: { ...row.storageRecord, metadata: storageMetadata }
    }
  })
