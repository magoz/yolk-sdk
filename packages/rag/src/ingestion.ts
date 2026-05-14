import { Effect } from 'effect'
import type { Chunker } from './chunking.ts'
import type { RagDocument } from './documents.ts'
import type { Embedder } from './embeddings.ts'
import type { VectorStore, VectorRecord } from './vector-store.ts'

export class IngestionError extends Error {
  readonly _tag = 'IngestionError'
}

export type IngestionPipeline = {
  readonly ingest: (documents: ReadonlyArray<RagDocument>) => Effect.Effect<void, IngestionError>
}

export const makeIngestionPipeline = (input: {
  readonly chunker: Chunker
  readonly embedder: Embedder
  readonly vectorStore: VectorStore
}): IngestionPipeline => ({
  ingest: documents =>
    Effect.gen(function* () {
      const chunks = documents.flatMap(document => input.chunker.chunk(document))
      const embeddings = yield* input.embedder.embed(chunks.map(chunk => chunk.text)).pipe(
        Effect.mapError(error => new IngestionError(error.message))
      )
      const records: ReadonlyArray<VectorRecord> = chunks.map((chunk, index) => ({
        chunk,
        embedding: embeddings[index] ?? []
      }))

      yield* input.vectorStore.upsert(records).pipe(
        Effect.mapError(error => new IngestionError(error.message))
      )
    })
})
