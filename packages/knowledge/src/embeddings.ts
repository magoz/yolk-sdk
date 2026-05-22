import { Context } from 'effect'
import type { Effect } from 'effect'
import type { KnowledgeEmbeddingError } from './errors.ts'

export type KnowledgeEmbedding = ReadonlyArray<number>

export type KnowledgeEmbedderApi = {
  readonly embedTexts: (
    texts: ReadonlyArray<string>
  ) => Effect.Effect<ReadonlyArray<KnowledgeEmbedding>, KnowledgeEmbeddingError>
  readonly embedQuery: (query: string) => Effect.Effect<KnowledgeEmbedding, KnowledgeEmbeddingError>
}

export class KnowledgeEmbedder extends Context.Service<KnowledgeEmbedder, KnowledgeEmbedderApi>()(
  '@yolk-sdk/knowledge/KnowledgeEmbedder'
) {}

export { KnowledgeEmbeddingError as EmbedderError } from './errors.ts'
