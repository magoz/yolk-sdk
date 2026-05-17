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
  readonly mode?: RagSearchMode
  readonly vectorLimit?: number
  readonly textLimit?: number
}

export type RagSearchMode = 'vector' | 'hybrid'

export type RagSearchScores = {
  readonly vector?: number
  readonly text?: number
  readonly fused?: number
}

export type RagSearchResult = {
  readonly chunk: RagChunk
  readonly score: number
  readonly document: RagDocument
  readonly context?: ReadonlyArray<RagChunk>
  readonly scores?: RagSearchScores
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

const defaultHybridCandidateLimit = (limit: number) => Math.max(limit * 5, 40)

const reciprocalRankFusionScore = (rank: number, rankConstant: number) => 1 / (rankConstant + rank)

export const fuseRagSearchResults = (input: {
  readonly vectorResults: ReadonlyArray<RagSearchResult>
  readonly textResults: ReadonlyArray<RagSearchResult>
  readonly limit: number
  readonly rankConstant?: number
}): ReadonlyArray<RagSearchResult> => {
  const rankConstant = input.rankConstant ?? 60
  const fused = new Map<
    string,
    {
      readonly result: RagSearchResult
      readonly vector?: number
      readonly text?: number
      readonly fused: number
    }
  >()

  const addResults = (results: ReadonlyArray<RagSearchResult>, kind: 'vector' | 'text') => {
    results.forEach((result, index) => {
      const rank = index + 1
      const previous = fused.get(result.chunk.id)
      const nextFused = (previous?.fused ?? 0) + reciprocalRankFusionScore(rank, rankConstant)
      fused.set(result.chunk.id, {
        result: previous?.result ?? result,
        vector: kind === 'vector' ? result.score : previous?.vector,
        text: kind === 'text' ? result.score : previous?.text,
        fused: nextFused
      })
    })
  }

  addResults(input.vectorResults, 'vector')
  addResults(input.textResults, 'text')

  return Array.from(fused.values())
    .sort((left, right) => right.fused - left.fused)
    .slice(0, input.limit)
    .map(item => ({
      ...item.result,
      score: item.fused,
      scores: { vector: item.vector, text: item.text, fused: item.fused }
    }))
}

const validateSearchInput = (input: RagSearchInput) => {
  const query = input.query.trim()
  const ids = scopeIds(input.scope)
  const limit = input.limit ?? 10
  const contextChunks = input.contextChunks ?? 0
  const mode = input.mode ?? 'hybrid'
  const vectorLimit = input.vectorLimit ?? (mode === 'hybrid' ? defaultHybridCandidateLimit(limit) : limit)
  const textLimit = input.textLimit ?? defaultHybridCandidateLimit(limit)

  if (query.length === 0) {
    return Effect.fail(new RagRetrievalError({ message: 'Search query is empty', stage: 'embed' }))
  }

  if (ids.length === 0) {
    return Effect.fail(new RagRetrievalError({ message: 'Search scope is empty', stage: 'store' }))
  }

  if (!Number.isInteger(limit) || limit < 1) {
    return Effect.fail(new RagRetrievalError({ message: 'Search limit must be positive', stage: 'store' }))
  }

  if (!Number.isInteger(vectorLimit) || vectorLimit < 1) {
    return Effect.fail(new RagRetrievalError({ message: 'Vector search limit must be positive', stage: 'store' }))
  }

  if (!Number.isInteger(textLimit) || textLimit < 1) {
    return Effect.fail(new RagRetrievalError({ message: 'Text search limit must be positive', stage: 'store' }))
  }

  if (mode !== 'vector' && mode !== 'hybrid') {
    return Effect.fail(new RagRetrievalError({ message: 'Search mode is invalid', stage: 'store' }))
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

  return Effect.succeed({ query, limit, contextChunks, mode, vectorLimit, textLimit })
}

const searchVectorChunks = (input: {
  readonly scope: RagSearchScope
  readonly query: string
  readonly limit: number
  readonly minScore?: number
}) =>
  Effect.gen(function* () {
    const store = yield* RagStore
    const embedder = yield* RagEmbedder
    const embedding = yield* embedder
      .embedQuery(input.query)
      .pipe(
        Effect.mapError(
          error => new RagRetrievalError({ message: error.message, stage: 'embed', cause: error })
        )
      )

    return yield* store
      .searchChunks({
        scope: input.scope,
        embedding,
        limit: input.limit,
        minScore: input.minScore
      })
      .pipe(
        Effect.mapError(
          error => new RagRetrievalError({ message: error.message, stage: 'store', cause: error })
        )
      )
  })

const searchTextChunks = (input: {
  readonly scope: RagSearchScope
  readonly query: string
  readonly limit: number
}) =>
  Effect.gen(function* () {
    const store = yield* RagStore
    return yield* store
      .searchChunksByText({ scope: input.scope, query: input.query, limit: input.limit })
      .pipe(
        Effect.mapError(
          error => new RagRetrievalError({ message: error.message, stage: 'store', cause: error })
        )
      )
  })

export const retrieveRag = (input: RagSearchInput) =>
  Effect.gen(function* () {
    const valid = yield* validateSearchInput(input)
    const store = yield* RagStore
    const results: ReadonlyArray<RagSearchResult> = valid.mode === 'vector'
      ? yield* searchVectorChunks({
        scope: input.scope,
        query: valid.query,
        limit: valid.vectorLimit,
        minScore: input.minScore
      })
      : yield* Effect.gen(function* () {
        const searches = yield* Effect.all(
          {
            vectorResults: searchVectorChunks({
              scope: input.scope,
              query: valid.query,
              limit: valid.vectorLimit,
              minScore: input.minScore
            }),
            textResults: searchTextChunks({
              scope: input.scope,
              query: valid.query,
              limit: valid.textLimit
            })
          },
          { concurrency: 'unbounded' }
        )

        return fuseRagSearchResults({
          vectorResults: searches.vectorResults,
          textResults: searches.textResults,
          limit: valid.limit
        })
      })

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
