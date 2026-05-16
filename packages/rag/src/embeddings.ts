import type { Effect } from 'effect'
import type { RagEmbeddingError } from './errors.ts'

export type RagEmbedding = ReadonlyArray<number>

export type RagEmbedder = {
  readonly embedTexts: (
    texts: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<RagEmbedding>, RagEmbeddingError>
  readonly embedQuery: (query: string) => Effect.Effect<RagEmbedding, RagEmbeddingError>
}

export { RagEmbeddingError as EmbedderError } from './errors.ts'
