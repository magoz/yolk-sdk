import { Effect } from 'effect'
import { ingestRagDocument } from '@yolk/rag/ingestion'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { ensureUserRagSet } from './ensure-user-rag-set'

const textMediaTypes = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json'])
const textExtensions = ['.txt', '.md', '.markdown', '.csv', '.json']

const isTextFile = (input: { readonly filename: string; readonly mediaType: string }) =>
  textMediaTypes.has(input.mediaType) ||
  textExtensions.some(extension => input.filename.toLowerCase().endsWith(extension))

export const createFileStorageObject = (input: {
  readonly userId: string
  readonly filename: string
  readonly mediaType: string
  readonly bytes: Uint8Array
}) =>
  Effect.gen(function* () {
    if (!isTextFile({ filename: input.filename, mediaType: input.mediaType })) {
      return yield* Effect.die(new Error('Only UTF-8 text-like files are supported'))
    }

    const content = new TextDecoder('utf-8', { fatal: false }).decode(input.bytes).trim()
    if (content.length === 0) {
      return yield* Effect.die(new Error('Storage file content is empty'))
    }

    const db = yield* Db
    const ragSet = yield* ensureUserRagSet({ userId: input.userId })
    const [object] = yield* db
      .insert(schema.storageObject)
      .values({
        userId: input.userId,
        sourceType: 'file',
        textContent: content,
        filename: input.filename,
        mediaType: input.mediaType.length > 0 ? input.mediaType : 'text/plain',
        byteSize: input.bytes.byteLength,
        metadata: { title: input.filename }
      })
      .returning()

    if (object === undefined) {
      return yield* Effect.die(new Error('Could not create storage object'))
    }

    yield* ingestRagDocument({
      ragSetId: ragSet.id,
      documentId: object.id,
      source: {
        source: { _tag: 'File', ref: object.id, name: object.filename ?? undefined, mediaType: object.mediaType ?? undefined },
        content,
        mediaType: object.mediaType ?? undefined,
        metadata: { storageObjectId: object.id, title: object.filename ?? undefined }
      }
    })

    return object
  }).pipe(Effect.withSpan('storage.createFileStorageObject'))
