import { Effect } from 'effect'
import { retrieveRag } from '@yolk/rag/retrieval'
import type { RagSearchScope } from '@yolk/rag/documents'
import { AppRagStoreError } from './errors'

const DEFAULT_LIMIT = 10
const DEFAULT_MIN_SCORE = 0.5
const DEFAULT_CONTEXT_CHUNKS = 0

export type SearchAppRagOptions = {
  readonly limit?: number
  readonly minScore?: number
  readonly contextChunks?: number
}

export const searchAppRag = (
  scope: RagSearchScope,
  query: string,
  options: SearchAppRagOptions = {}
) => {
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE

  if (!Number.isFinite(minScore)) {
    return Effect.fail(new AppRagStoreError({ message: 'Search minScore must be finite' }))
  }

  return retrieveRag({
    scope,
    query,
    limit: options.limit ?? DEFAULT_LIMIT,
    minScore,
    contextChunks: options.contextChunks ?? DEFAULT_CONTEXT_CHUNKS
  }).pipe(
    Effect.withSpan('rag.search'),
    Effect.mapError(error => new AppRagStoreError({ message: error.message, cause: error }))
  )
}
