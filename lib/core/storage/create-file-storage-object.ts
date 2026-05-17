import { Effect } from 'effect'
import { ingestRagDocument } from '@yolk/rag/ingestion'
import { PersistenceError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { FileExtractor } from '@/lib/services/file-extractor/live-layer'
import { ensureUserRagSet } from './ensure-user-rag-set'

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
    const ragSet = yield* ensureUserRagSet({ userId: input.userId })
    const [object] = yield* db
      .insert(schema.storageObject)
      .values({
        userId: input.userId,
        sourceType: 'file',
        textContent: extracted.content,
        filename: input.filename,
        mediaType: input.mediaType.length > 0 ? input.mediaType : extracted.metadata.format,
        byteSize: input.bytes.byteLength,
        metadata: { title: input.filename, ...extracted.metadata }
      })
      .returning()

    if (object === undefined) {
      return yield* Effect.fail(
        new PersistenceError({ message: 'Could not create storage object', entity: 'storageObject' })
      )
    }

    yield* ingestRagDocument({
      ragSetId: ragSet.id,
      documentId: object.id,
      source: {
        source: {
          _tag: 'File',
          ref: object.id,
          name: object.filename ?? undefined,
          mediaType: object.mediaType ?? undefined
        },
        content: extracted.content,
        mediaType: object.mediaType ?? undefined,
        metadata: { storageObjectId: object.id, title: object.filename ?? undefined, ...extracted.metadata }
      }
    })

    return object
  }).pipe(Effect.withSpan('storage.createFileStorageObject'))
