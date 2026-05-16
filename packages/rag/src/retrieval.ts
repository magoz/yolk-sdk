import { Effect } from 'effect'
import type { RagChunk, RagDocument, RagSearchScope } from './documents.ts'
import { RagEmbedder } from './embeddings.ts'
import { RagRetrievalError } from './errors.ts'
import { RagStore } from './store.ts'

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

const packedResultText = (result: RagSearchResult) =>
  result.context?.map(chunk => chunk.content).join('\n\n') ?? result.chunk.content

export const packRagContext = (query: string, results: ReadonlyArray<RagSearchResult>): RagContext =>
  ({
    query,
    results,
    text: results.map(packedResultText).join('\n\n')
  })

const scopeIds = (scope: RagSearchScope): ReadonlyArray<string> => {
  switch (scope._tag) {
    case 'RagSet':
      return [scope.id]
    case 'RagSets':
      return scope.ids
  }
}

const validateSearchInput = (input: RagSearchInput) => {
  const query = input.query.trim()
  const ids = scopeIds(input.scope)
  const limit = input.limit ?? 10
  const contextChunks = input.contextChunks ?? 0

  if (query.length === 0) {
    return Effect.fail(new RagRetrievalError({ message: 'Search query is empty', stage: 'embed' }))
  }

  if (ids.length === 0) {
    return Effect.fail(new RagRetrievalError({ message: 'Search scope is empty', stage: 'store' }))
  }

  if (!Number.isInteger(limit) || limit < 1) {
    return Effect.fail(new RagRetrievalError({ message: 'Search limit must be positive', stage: 'store' }))
  }

  if (!Number.isInteger(contextChunks) || contextChunks < 0) {
    return Effect.fail(
      new RagRetrievalError({ message: 'Context chunks must be zero or positive', stage: 'store' })
    )
  }

  if (input.minScore !== undefined && !Number.isFinite(input.minScore)) {
    return Effect.fail(
      new RagRetrievalError({ message: 'Search minScore must be finite', stage: 'store' })
    )
  }

  return Effect.succeed({ query, limit, contextChunks })
}

export const retrieveRag = (input: RagSearchInput) =>
  Effect.gen(function* () {
    const valid = yield* validateSearchInput(input)
    const store = yield* RagStore
    const embedder = yield* RagEmbedder
    const embedding = yield* embedder
      .embedQuery(valid.query)
      .pipe(
        Effect.mapError(
          error => new RagRetrievalError({ message: error.message, stage: 'embed', cause: error })
        )
      )
    const results: ReadonlyArray<RagSearchResult> = yield* store
      .searchChunks({
        scope: input.scope,
        embedding,
        limit: valid.limit,
        minScore: input.minScore
      })
      .pipe(
        Effect.mapError(
          error => new RagRetrievalError({ message: error.message, stage: 'store', cause: error })
        )
      )

    if (valid.contextChunks === 0) {
      return results
    }

    return yield* Effect.forEach(results, result =>
      store
        .getContextChunks({
          ragSetId: result.chunk.ragSetId,
          documentId: result.chunk.documentId,
          position: result.chunk.position,
          contextChunks: valid.contextChunks
        })
        .pipe(
          Effect.map(context => ({ ...result, context })),
          Effect.mapError(
            error => new RagRetrievalError({ message: error.message, stage: 'store', cause: error })
          )
        )
    )
  })
