import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import {
  KnowledgeDocumentId,
  KnowledgeScopeId,
  KnowledgeTextSource
} from '@yolk-sdk/knowledge/documents'
import { ingestKnowledgeDocument } from '@yolk-sdk/knowledge/ingestion'
import { PersistenceError, ValidationError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { encodePersistedMetadata } from './encode-persisted-metadata'
import { ensureUserKnowledgeCollection } from './ensure-user-knowledge-collection'

export const createTextStorageObject = (input: {
  readonly userId: string
  readonly title: string
  readonly content: string
}) =>
  Effect.gen(function* () {
    const trimmedTitle = input.title.trim()
    const trimmedContent = input.content.trim()

    if (trimmedContent.length === 0) {
      return yield* Effect.fail(
        new ValidationError({ message: 'Storage text content is empty', field: 'content' })
      )
    }

    const db = yield* Db
    const collection = yield* ensureUserKnowledgeCollection({ userId: input.userId })

    const metadata = yield* encodePersistedMetadata({
      value: { title: trimmedTitle },
      entity: 'storageObject'
    })

    const [object] = yield* db
      .insert(schema.storageObject)
      .values({
        userId: input.userId,
        sourceType: 'text',
        textContent: trimmedContent,
        filename: trimmedTitle.length > 0 ? trimmedTitle : 'Untitled note',
        mediaType: 'text/plain',
        byteSize: new TextEncoder().encode(trimmedContent).byteLength,
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
        source: KnowledgeTextSource.make({
          label: object.filename ?? undefined
        }),
        content: trimmedContent,
        mediaType: 'text/plain',
        metadata: { storageObjectId: object.id, title: object.filename ?? undefined }
      }
    })

    return object
  }).pipe(Effect.withSpan('storage.createTextStorageObject'))
