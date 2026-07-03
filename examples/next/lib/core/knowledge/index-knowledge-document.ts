import { Array as Arr, Effect } from 'effect'
import { eq, sql } from 'drizzle-orm'
import { KnowledgeChunker } from '@yolk-sdk/knowledge/chunking'
import { KnowledgeEmbedder } from '@yolk-sdk/knowledge/embeddings'
import { PersistenceError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

export const indexKnowledgeDocument = (input: {
  readonly userId: string
  readonly documentId: string
  readonly content: string
  readonly metadata?: Record<string, unknown>
}) =>
  Effect.gen(function* () {
    const db = yield* Db
    const chunker = yield* KnowledgeChunker
    const embedder = yield* KnowledgeEmbedder

    yield* db
      .update(schema.userKnowledgeDocument)
      .set({ status: 'processing', errorMessage: null, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(schema.userKnowledgeDocument.id, input.documentId))

    const chunks = yield* chunker.chunk({
      scopeId: input.userId,
      documentId: input.documentId,
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

    return yield* db.transaction(tx =>
      Effect.gen(function* () {
        yield* tx
          .delete(schema.userKnowledgeChunk)
          .where(eq(schema.userKnowledgeChunk.documentId, input.documentId))

        const indexedChunks = Arr.zip(chunks, embeddings)
        if (indexedChunks.length > 0) {
          yield* tx.insert(schema.userKnowledgeChunk).values(
            indexedChunks.map(([chunk, embedding]) => ({
              id: chunk.id,
              scopeId: input.userId,
              documentId: input.documentId,
              content: chunk.content,
              embedding: Array.from(embedding),
              position: chunk.position,
              tokenCount: chunk.tokenCount,
              metadata: chunk.metadata ?? {}
            }))
          )
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
