import { Effect } from 'effect'
import { ingestKnowledgeDocument } from '@yolk-sdk/knowledge/ingestion'
import { PersistenceError, ValidationError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
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
      return yield* Effect.fail(new ValidationError({ message: 'Storage text content is empty', field: 'content' }))
    }

    const db = yield* Db
    const collection = yield* ensureUserKnowledgeCollection({ userId: input.userId })
    const [object] = yield* db
      .insert(schema.storageObject)
      .values({
        userId: input.userId,
        sourceType: 'text',
        textContent: trimmedContent,
        filename: trimmedTitle.length > 0 ? trimmedTitle : 'Untitled note',
        mediaType: 'text/plain',
        byteSize: new TextEncoder().encode(trimmedContent).byteLength,
        metadata: { title: trimmedTitle }
      })
      .returning()

    if (object === undefined) {
      return yield* Effect.fail(
        new PersistenceError({ message: 'Could not create storage object', entity: 'storageObject' })
      )
    }

    yield* ingestKnowledgeDocument({
      scopeId: collection.id,
      documentId: object.id,
      maxTokens: collection.chunkMaxTokens,
      source: {
        source: { _tag: 'Text', label: object.filename ?? undefined },
        content: trimmedContent,
        mediaType: 'text/plain',
        metadata: { storageObjectId: object.id, title: object.filename ?? undefined }
      }
    })

    return object
  }).pipe(Effect.withSpan('storage.createTextStorageObject'))
