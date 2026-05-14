import type { Effect } from 'effect'
import type { RagChunk } from './documents.ts'

export type RetrievalQuery = {
  readonly query: string
  readonly limit: number
}

export type RetrievalResult = {
  readonly chunk: RagChunk
  readonly score: number
}

export type RagContext = {
  readonly query: string
  readonly results: ReadonlyArray<RetrievalResult>
  readonly text: string
}

export class RetrieverError extends Error {
  readonly _tag = 'RetrieverError'
}

export type Retriever = {
  readonly retrieve: (query: RetrievalQuery) => Effect.Effect<ReadonlyArray<RetrievalResult>, RetrieverError>
}

export const packRagContext = (
  query: string,
  results: ReadonlyArray<RetrievalResult>
): RagContext => ({
  query,
  results,
  text: results.map(result => result.chunk.text).join('\n\n')
})
