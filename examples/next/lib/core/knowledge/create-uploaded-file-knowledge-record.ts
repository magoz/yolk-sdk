import { createId } from '@paralleldrive/cuid2'
import { eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { KnowledgeArtifactStore } from '@yolk-sdk/knowledge/artifacts'
import { PersistenceError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { FileExtractor } from '@/lib/services/file-extractor/live-layer'
import { indexKnowledgeRepresentation } from './index-knowledge-representation'

export const createUploadedFileKnowledgeRecord = (input: {
  readonly userId: string
  readonly filename: string
  readonly mediaType: string
  readonly storageKey: string
  readonly bytes: Uint8Array
  readonly pinned: boolean
}) =>
  Effect.gen(function* () {
    const extractor = yield* FileExtractor
    const artifactStore = yield* KnowledgeArtifactStore
    const artifactBytes = new Uint8Array(input.bytes)
    const extractionBytes = new Uint8Array(input.bytes)
    const byteSize = artifactBytes.byteLength
    const extracted = yield* extractor.extract({ ...input, bytes: extractionBytes })
    const db = yield* Db

    const [object] = yield* db
      .insert(schema.knowledgeRecord)
      .values({
        userId: input.userId,
        role: 'source',
        title: extracted.metadata.title ?? input.filename,
        status: 'ready',
        contextPolicy: input.pinned ? 'pinned' : 'searchable',
        summary: extracted.content.length <= 500 ? extracted.content : `${extracted.content.slice(0, 500)}…`,
        metadata: { filename: input.filename, mediaType: input.mediaType, ...extracted.metadata }
      })
      .returning()

    if (object === undefined) {
      return yield* Effect.fail(new PersistenceError({ message: 'Could not create knowledge record', entity: 'knowledgeRecord' }))
    }

    return yield* Effect.gen(function* () {
      const [artifact] = yield* db
        .insert(schema.knowledgeArtifact)
        .values({
          id: createId(),
          recordId: object.id,
          kind: 'original',
          storageKey: input.storageKey,
          mediaType: input.mediaType.length > 0 ? input.mediaType : extracted.metadata.format,
          byteSize,
          metadata: { filename: input.filename, ...extracted.metadata }
        })
        .returning()

      if (artifact === undefined) {
        return yield* Effect.fail(new PersistenceError({ message: 'Could not create knowledge artifact', entity: 'knowledgeArtifact' }))
      }

      const [representation] = yield* db.insert(schema.knowledgeRepresentation).values({
        recordId: object.id,
        artifactId: artifact.id,
        modality: 'text',
        status: 'pending',
        contentText: extracted.content,
        summary: object.summary,
        metadata: { filename: input.filename, ...extracted.metadata }
      }).returning()

      if (representation === undefined) {
        return yield* Effect.fail(new PersistenceError({ message: 'Could not create knowledge representation', entity: 'knowledgeRepresentation' }))
      }

      yield* db.insert(schema.knowledgeProvenance).values({
        recordId: object.id,
        artifactId: artifact.id,
        sourceKind: 'upload',
        sourceLabel: input.filename,
        observedAt: new Date(),
        metadata: { mediaType: input.mediaType, byteSize }
      })

      yield* indexKnowledgeRepresentation({
        recordId: object.id,
        representationId: representation.id,
        content: extracted.content,
        metadata: { filename: input.filename, ...extracted.metadata }
      })

      return object
    }).pipe(
      Effect.catch(error =>
        Effect.all(
          [
            artifactStore.deleteArtifact({ storageKey: input.storageKey }).pipe(Effect.ignore),
            db.delete(schema.knowledgeRecord).where(eq(schema.knowledgeRecord.id, object.id)).pipe(Effect.ignore)
          ],
          { concurrency: 'unbounded' }
        ).pipe(Effect.andThen(Effect.fail(error)))
      )
    )
  }).pipe(Effect.withSpan('knowledge.createUploadedFileKnowledgeRecord'))
