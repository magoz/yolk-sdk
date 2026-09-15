import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import {
  KnowledgeDocumentId,
  KnowledgeFileSource,
  KnowledgeScopeId
} from '@yolk-sdk/knowledge/documents'
import { ingestKnowledgeDocument } from '@yolk-sdk/knowledge/ingestion'
import { PersistenceError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { FileExtractor } from '@/lib/services/file-extractor/live-layer'
import { encodePersistedMetadata } from './encode-persisted-metadata'
import { ensureUserKnowledgeCollection } from './ensure-user-knowledge-collection'

const presentSourceText = (value: string | null) => {
  if (value === null) {
    return undefined
  }

  const trimmed = value.trim()

  return trimmed.length > 0 ? trimmed : undefined
}

export const createFileStorageObject = (input: {
  readonly userId: string
  readonly filename: string
  readonly mediaType: string
  readonly bytes: Uint8Array
}) =>
  Effect.gen(function* () {
    const extractor = yield* FileExtractor
    const extracted = yield* extractor.extract(input)

    const db = yield* Db
    const collection = yield* ensureUserKnowledgeCollection({ userId: input.userId })

    const metadata = yield* encodePersistedMetadata({
      value: { title: input.filename, ...extracted.metadata },
      entity: 'storageObject'
    })

    const [object] = yield* db
      .insert(schema.storageObject)
      .values({
        userId: input.userId,
        sourceType: 'file',
        textContent: extracted.content,
        filename: input.filename,
        mediaType: input.mediaType.length > 0 ? input.mediaType : extracted.metadata.format,
        byteSize: input.bytes.byteLength,
        metadata
      })
      .returning()

    if (object === undefined) {
      return yield* Effect.fail(
        new PersistenceError({
          message: 'Could not create storage object',
          entity: 'storageObject'
        })
      )
    }

    const scopeId = yield* Schema.decodeUnknownEffect(KnowledgeScopeId)(collection.id).pipe(
      Effect.mapError(
        error =>
          new PersistenceError({
            message: 'Invalid knowledge scope id',
            entity: 'knowledgeCollection',
            cause: error
          })
      )
    )

    const documentId = yield* Schema.decodeUnknownEffect(KnowledgeDocumentId)(object.id).pipe(
      Effect.mapError(
        error =>
          new PersistenceError({
            message: 'Invalid knowledge document id',
            entity: 'storageObject',
            cause: error
          })
      )
    )

    yield* ingestKnowledgeDocument({
      scopeId,
      documentId,
      maxTokens: collection.chunkMaxTokens,
      source: {
        source: KnowledgeFileSource.make({
          ref: object.id,
          name: presentSourceText(object.filename),
          mediaType: presentSourceText(object.mediaType)
        }),
        content: extracted.content,
        mediaType: object.mediaType ?? undefined,
        metadata: {
          storageObjectId: object.id,
          title: object.filename ?? undefined,
          ...extracted.metadata
        }
      }
    })

    return object
  }).pipe(Effect.withSpan('storage.createFileStorageObject'))
