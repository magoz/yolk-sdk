import { Context } from 'effect'
import type { Effect } from 'effect'
import type { RagEmbeddingError } from './errors.ts'

export type RagEmbedding = ReadonlyArray<number>

export type RagEmbedderApi = {
  readonly embedTexts: (
    texts: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<RagEmbedding>, RagEmbeddingError>
  readonly embedQuery: (query: string) => Effect.Effect<RagEmbedding, RagEmbeddingError>
}

export class RagEmbedder extends Context.Service<RagEmbedder, RagEmbedderApi>()(
  '@yolk/rag/RagEmbedder'
) {}

export { RagEmbeddingError as EmbedderError } from './errors.ts'
