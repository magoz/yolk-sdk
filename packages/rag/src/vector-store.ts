import type { Effect } from 'effect'
import type { RagChunk } from './documents.ts'
import type { Embedding } from './embeddings.ts'

export type VectorRecord = {
  readonly chunk: RagChunk
  readonly embedding: Embedding
}

export type VectorSearchQuery = {
  readonly embedding: Embedding
  readonly limit: number
}

export type VectorSearchResult = {
  readonly chunk: RagChunk
  readonly score: number
}

export class VectorStoreError extends Error {
  readonly _tag = 'VectorStoreError'
}

export type VectorStore = {
  readonly upsert: (records: ReadonlyArray<VectorRecord>) => Effect.Effect<void, VectorStoreError>
  readonly search: (query: VectorSearchQuery) => Effect.Effect<ReadonlyArray<VectorSearchResult>, VectorStoreError>
}
