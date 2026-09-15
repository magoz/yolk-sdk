import { Array as Arr, Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { eq, sql } from 'drizzle-orm'
import { KnowledgeChunker } from '@yolk-sdk/knowledge/chunking'
import {
  KnowledgeDocumentId,
  KnowledgeScopeId,
  type KnowledgeMetadata
} from '@yolk-sdk/knowledge/documents'
import { KnowledgeEmbedder } from '@yolk-sdk/knowledge/embeddings'
import { PersistenceError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import { encodePersistedMetadata } from './encode-persisted-metadata'

export const indexKnowledgeDocument = (input: {
  readonly userId: string
  readonly documentId: string
  readonly content: string
  readonly metadata?: KnowledgeMetadata
}) =>
  Effect.gen(function* () {
    const db = yield* Db
    const chunker = yield* KnowledgeChunker
    const embedder = yield* KnowledgeEmbedder

    yield* db
      .update(schema.userKnowledgeDocument)
      .set({ status: 'processing', errorMessage: null, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(schema.userKnowledgeDocument.id, input.documentId))

    const scopeId = yield* Schema.decodeUnknownEffect(KnowledgeScopeId)(input.userId).pipe(
      Effect.mapError(
        error =>
          new PersistenceError({
            message: 'Invalid knowledge scope id',
            entity: 'userKnowledgeDocument',
            cause: error
          })
      )
    )

    const documentId = yield* Schema.decodeUnknownEffect(KnowledgeDocumentId)(
      input.documentId
    ).pipe(
      Effect.mapError(
        error =>
          new PersistenceError({
            message: 'Invalid knowledge document id',
            entity: 'userKnowledgeDocument',
            cause: error
          })
      )
    )

    const chunks = yield* chunker.chunk({
      scopeId,
      documentId,
      content: input.content,
      metadata: input.metadata
    })

    const embeddings = yield* embedder.embedTexts(chunks.map(chunk => chunk.content))

    if (embeddings.length !== chunks.length) {
      return yield* Effect.fail(
        new PersistenceError({
          message: 'Embedding count did not match chunk count',
          entity: 'userKnowledgeChunk'
        })
      )
    }

    const indexedChunks = Arr.zip(chunks, embeddings)

    const chunkRows = yield* Effect.forEach(indexedChunks, ([chunk, embedding]) =>
      encodePersistedMetadata({
        value: chunk.metadata === undefined ? {} : chunk.metadata,
        entity: 'userKnowledgeChunk'
      }).pipe(
        Effect.map(metadata => ({
          id: chunk.id,
          scopeId: input.userId,
          documentId: input.documentId,
          content: chunk.content,
          embedding: Array.from(embedding),
          position: chunk.position,
          tokenCount: chunk.tokenCount,
          metadata
        }))
      )
    )

    return yield* db.transaction(tx =>
      Effect.gen(function* () {
        yield* tx
          .delete(schema.userKnowledgeChunk)
          .where(eq(schema.userKnowledgeChunk.documentId, input.documentId))

        if (chunkRows.length > 0) {
          yield* tx.insert(schema.userKnowledgeChunk).values(chunkRows)
        }

        return yield* tx
          .update(schema.userKnowledgeDocument)
          .set({ status: 'ready', errorMessage: null, updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(schema.userKnowledgeDocument.id, input.documentId))
          .returning()
          .pipe(
            Effect.flatMap(([document]) =>
              document === undefined
                ? Effect.fail(
                    new PersistenceError({
                      message: 'Could not mark knowledge document ready',
                      entity: 'userKnowledgeDocument'
                    })
                  )
                : Effect.succeed(document)
            )
          )
      })
    )
  }).pipe(
    Effect.withSpan('knowledge.indexKnowledgeDocument'),
    Effect.catch(error =>
      Effect.gen(function* () {
        const db = yield* Db
        yield* db
          .update(schema.userKnowledgeDocument)
          .set({
            status: 'error',
            errorMessage: error instanceof Error ? error.message : String(error),
            updatedAt: sql`CURRENT_TIMESTAMP`
          })
          .where(eq(schema.userKnowledgeDocument.id, input.documentId))

        return yield* Effect.fail(error)
      })
    )
  )
