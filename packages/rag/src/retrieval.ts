import type { Effect } from 'effect'
import type { RagChunk, RagDocument, RagSearchScope } from './documents.ts'
import type { RagRetrievalError } from './errors.ts'

export type RagSearchInput = {
  readonly scope: RagSearchScope
  readonly query: string
  readonly limit?: number
  readonly minScore?: number
  readonly contextChunks?: number
}

export type RagSearchResult = {
  readonly chunk: RagChunk
  readonly score: number
  readonly document: RagDocument
  readonly context?: ReadonlyArray<RagChunk>
}

export type RagContext = {
  readonly query: string
  readonly results: ReadonlyArray<RagSearchResult>
  readonly text: string
}

export type RagRetriever = {
  readonly retrieve: (
    input: RagSearchInput
  ) => Effect.Effect<ReadonlyArray<RagSearchResult>, RagRetrievalError>
}

export const packRagContext = (query: string, results: ReadonlyArray<RagSearchResult>): RagContext => ({
  query,
  results,
  text: results.map(result => result.context?.map(chunk => chunk.content).join('\n\n') ?? result.chunk.content).join('\n\n')
})
