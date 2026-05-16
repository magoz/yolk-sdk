import { Effect } from 'effect'
import { ingestRagDocument } from '@yolk/rag/ingestion'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { ensureUserRagSet } from './ensure-user-rag-set'

export const createTextStorageObject = (input: {
  readonly userId: string
  readonly title: string
  readonly content: string
}) =>
  Effect.gen(function* () {
    const trimmedTitle = input.title.trim()
    const trimmedContent = input.content.trim()

    if (trimmedContent.length === 0) {
      return yield* Effect.die(new Error('Storage text content is empty'))
    }

    const db = yield* Db
    const ragSet = yield* ensureUserRagSet({ userId: input.userId })
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
      return yield* Effect.die(new Error('Could not create storage object'))
    }

    yield* ingestRagDocument({
      ragSetId: ragSet.id,
      documentId: object.id,
      source: {
        source: { _tag: 'Text', label: object.filename ?? undefined },
        content: trimmedContent,
        mediaType: 'text/plain',
        metadata: { storageObjectId: object.id, title: object.filename ?? undefined }
      }
    })

    return object
  }).pipe(Effect.withSpan('storage.createTextStorageObject'))
