import { Array as Arr, Effect } from 'effect'
import { eq, sql } from 'drizzle-orm'
import { KnowledgeChunker } from '@yolk-sdk/knowledge/chunking'
import { KnowledgeEmbedder } from '@yolk-sdk/knowledge/embeddings'
import { PersistenceError } from '@/lib/core/errors'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'

export const indexKnowledgeRepresentation = (input: {
  readonly recordId: string
  readonly representationId: string
  readonly content: string
  readonly metadata?: Record<string, unknown>
}) =>
  Effect.gen(function* () {
    const db = yield* Db
    const chunker = yield* KnowledgeChunker
    const embedder = yield* KnowledgeEmbedder

    yield* db
      .update(schema.knowledgeRepresentation)
      .set({ status: 'processing', errorMessage: null, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(schema.knowledgeRepresentation.id, input.representationId))

    const chunks = yield* chunker.chunk({
      collectionId: input.recordId,
      documentId: input.representationId,
      content: input.content,
      metadata: input.metadata
    })
    const embeddings = yield* embedder.embedTexts(chunks.map(chunk => chunk.content))

    if (embeddings.length !== chunks.length) {
      return yield* Effect.fail(new PersistenceError({ message: 'Embedding count did not match chunk count', entity: 'knowledgeRepresentationChunk' }))
    }

    yield* db.transaction(tx =>
      Effect.gen(function* () {
        yield* tx
          .delete(schema.knowledgeRepresentationChunk)
          .where(eq(schema.knowledgeRepresentationChunk.representationId, input.representationId))

        const indexedChunks = Arr.zip(chunks, embeddings)
        if (indexedChunks.length > 0) {
          yield* tx.insert(schema.knowledgeRepresentationChunk).values(
            indexedChunks.map(([chunk, embedding]) => ({
              id: chunk.id,
              recordId: input.recordId,
              representationId: input.representationId,
              content: chunk.content,
              embedding: Array.from(embedding),
              position: chunk.position,
              tokenCount: chunk.tokenCount,
              metadata: chunk.metadata ?? {}
            }))
          )
        }

        yield* tx
          .update(schema.knowledgeRepresentation)
          .set({ status: 'ready', errorMessage: null, updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(schema.knowledgeRepresentation.id, input.representationId))
      })
    )
  }).pipe(
    Effect.withSpan('knowledge.indexKnowledgeRepresentation'),
    Effect.catch(error =>
      Effect.gen(function* () {
        const db = yield* Db
        yield* db
          .update(schema.knowledgeRepresentation)
          .set({ status: 'error', errorMessage: error instanceof Error ? error.message : String(error), updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(eq(schema.knowledgeRepresentation.id, input.representationId))
        return yield* Effect.fail(error)
      })
    )
  )
