import { createId } from '@paralleldrive/cuid2'
import { eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { KnowledgeFileBlobStore } from '@yolk-sdk/knowledge/files'
import { PersistenceError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import { FileExtractor } from '@/lib/services/file-extractor/live-layer'
import { knowledgeFileStorageKey } from '@/lib/services/knowledge/live-layer'
import * as schema from '@/lib/services/db/schema'
import { indexKnowledgeDocument } from './index-knowledge-document'
import { knowledgeSlugFromTitle } from './slug'

export const createFileKnowledgeDocument = (input: {
  readonly userId: string
  readonly filename: string
  readonly mediaType: string
  readonly bytes: Uint8Array
  readonly pinned: boolean
}) =>
  Effect.gen(function* () {
    const extractor = yield* FileExtractor
    const fileStore = yield* KnowledgeFileBlobStore
    const fileBytes = new Uint8Array(input.bytes)
    const extractionBytes = new Uint8Array(input.bytes)
    const byteSize = fileBytes.byteLength
    const extracted = yield* extractor.extract({ ...input, bytes: extractionBytes })
    const db = yield* Db
    const documentId = createId()
    const title = extracted.metadata.title ?? input.filename

    const [document] = yield* db
      .insert(schema.userKnowledgeDocument)
      .values({
        id: documentId,
        userId: input.userId,
        slug: knowledgeSlugFromTitle(title, documentId),
        title,
        purpose: 'Uploaded file knowledge',
        origin: 'file_upload',
        content: extracted.content,
        status: 'processing',
        availability: input.pinned ? 'pinned' : 'searchable',
        summary:
          extracted.content.length <= 500
            ? extracted.content
            : `${extracted.content.slice(0, 500)}…`,
        metadata: { filename: input.filename, mediaType: input.mediaType, ...extracted.metadata }
      })
      .returning()

    if (document === undefined) {
      return yield* Effect.fail(
        new PersistenceError({
          message: 'Could not create knowledge document',
          entity: 'userKnowledgeDocument'
        })
      )
    }

    const fileId = createId()
    const storageKey = knowledgeFileStorageKey({
      documentId: document.id,
      fileId,
      kind: 'original'
    })
    return yield* Effect.gen(function* () {
      yield* fileStore.putFile({
        storageKey,
        mediaType: input.mediaType.length > 0 ? input.mediaType : undefined,
        bytes: fileBytes
      })

      const [file] = yield* db
        .insert(schema.userKnowledgeFile)
        .values({
          id: fileId,
          documentId: document.id,
          storageKey,
          mediaType: input.mediaType.length > 0 ? input.mediaType : extracted.metadata.format,
          byteSize,
          metadata: { filename: input.filename, ...extracted.metadata }
        })
        .returning()

      if (file === undefined) {
        return yield* Effect.fail(
          new PersistenceError({
            message: 'Could not create knowledge file',
            entity: 'userKnowledgeFile'
          })
        )
      }

      return yield* indexKnowledgeDocument({
        userId: input.userId,
        documentId: document.id,
        content: extracted.content,
        metadata: { filename: input.filename, ...extracted.metadata }
      })
    }).pipe(
      Effect.catch(error =>
        Effect.all(
          [
            fileStore.deleteFile({ storageKey }).pipe(Effect.ignore),
            db
              .delete(schema.userKnowledgeDocument)
              .where(eq(schema.userKnowledgeDocument.id, document.id))
              .pipe(Effect.ignore)
          ],
          { concurrency: 'unbounded' }
        ).pipe(Effect.andThen(Effect.fail(error)))
      )
    )
  }).pipe(Effect.withSpan('knowledge.createFileKnowledgeDocument'))
