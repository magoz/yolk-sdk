import { Effect } from 'effect'
import type { IndexedKnowledgeDocument, KnowledgeChunk, KnowledgeSearchScope } from './documents.ts'
import { KnowledgeEmbedder } from './embeddings.ts'
import { KnowledgeSearchError } from './errors.ts'
import { SearchIndexStore } from './store.ts'

export type KnowledgeSearchInput = {
  readonly scope: KnowledgeSearchScope
  readonly query: string
  readonly limit?: number
  readonly minScore?: number
  readonly contextChunks?: number
  readonly mode?: KnowledgeSearchMode
  readonly vectorLimit?: number
  readonly textLimit?: number
}

export type KnowledgeSearchMode = 'vector' | 'hybrid'

export type KnowledgeSearchScores = {
  readonly vector?: number
  readonly text?: number
  readonly fused?: number
}

export type KnowledgeSearchResult = {
  readonly chunk: KnowledgeChunk
  readonly score: number
  readonly document: IndexedKnowledgeDocument
  readonly context?: ReadonlyArray<KnowledgeChunk>
  readonly scores?: KnowledgeSearchScores
}

export type KnowledgeSearchContext = {
  readonly query: string
  readonly results: ReadonlyArray<KnowledgeSearchResult>
  readonly text: string
}

export type KnowledgeSearcher = {
  readonly search: (
    input: KnowledgeSearchInput
  ) => Effect.Effect<ReadonlyArray<KnowledgeSearchResult>, KnowledgeSearchError>
}

const packedResultText = (result: KnowledgeSearchResult) =>
  result.context?.map(chunk => chunk.content).join('\n\n') ?? result.chunk.content

export const packKnowledgeSearchContext = (query: string, results: ReadonlyArray<KnowledgeSearchResult>): KnowledgeSearchContext =>
  ({
    query,
    results,
    text: results.map(packedResultText).join('\n\n')
  })

const scopeIds = (scope: KnowledgeSearchScope): ReadonlyArray<string> => {
  switch (scope._tag) {
    case 'KnowledgeScope':
      return [scope.id]
    case 'KnowledgeScopes':
      return scope.ids
  }
}

const defaultHybridCandidateLimit = (limit: number) => Math.max(limit * 5, 40)

const reciprocalRankFusionScore = (rank: number, rankConstant: number) => 1 / (rankConstant + rank)

export const fuseKnowledgeSearchResults = (input: {
  readonly vectorResults: ReadonlyArray<KnowledgeSearchResult>
  readonly textResults: ReadonlyArray<KnowledgeSearchResult>
  readonly limit: number
  readonly rankConstant?: number
}): ReadonlyArray<KnowledgeSearchResult> => {
  const rankConstant = input.rankConstant ?? 60
  const fused = new Map<
    string,
    {
      readonly result: KnowledgeSearchResult
      readonly vector?: number
      readonly text?: number
      readonly fused: number
    }
  >()

  const addResults = (results: ReadonlyArray<KnowledgeSearchResult>, kind: 'vector' | 'text') => {
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

const validateSearchInput = (input: KnowledgeSearchInput) => {
  const query = input.query.trim()
  const ids = scopeIds(input.scope)
  const limit = input.limit ?? 10
  const contextChunks = input.contextChunks ?? 0
  const mode = input.mode ?? 'hybrid'
  const vectorLimit = input.vectorLimit ?? (mode === 'hybrid' ? defaultHybridCandidateLimit(limit) : limit)
  const textLimit = input.textLimit ?? defaultHybridCandidateLimit(limit)

  if (query.length === 0) {
    return Effect.fail(new KnowledgeSearchError({ message: 'Search query is empty', stage: 'embed' }))
  }

  if (ids.length === 0) {
    return Effect.fail(new KnowledgeSearchError({ message: 'Search scope is empty', stage: 'store' }))
  }

  if (!Number.isInteger(limit) || limit < 1) {
    return Effect.fail(new KnowledgeSearchError({ message: 'Search limit must be positive', stage: 'store' }))
  }

  if (!Number.isInteger(vectorLimit) || vectorLimit < 1) {
    return Effect.fail(new KnowledgeSearchError({ message: 'Vector search limit must be positive', stage: 'store' }))
  }

  if (!Number.isInteger(textLimit) || textLimit < 1) {
    return Effect.fail(new KnowledgeSearchError({ message: 'Text search limit must be positive', stage: 'store' }))
  }

  if (mode !== 'vector' && mode !== 'hybrid') {
    return Effect.fail(new KnowledgeSearchError({ message: 'Search mode is invalid', stage: 'store' }))
  }

  if (!Number.isInteger(contextChunks) || contextChunks < 0) {
    return Effect.fail(
      new KnowledgeSearchError({ message: 'Context chunks must be zero or positive', stage: 'store' })
    )
  }

  if (input.minScore !== undefined && !Number.isFinite(input.minScore)) {
    return Effect.fail(
      new KnowledgeSearchError({ message: 'Search minScore must be finite', stage: 'store' })
    )
  }

  return Effect.succeed({ query, limit, contextChunks, mode, vectorLimit, textLimit })
}

const searchVectorChunks = (input: {
  readonly scope: KnowledgeSearchScope
  readonly query: string
  readonly limit: number
  readonly minScore?: number
}) =>
  Effect.gen(function* () {
    const store = yield* SearchIndexStore
    const embedder = yield* KnowledgeEmbedder
    const embedding = yield* embedder
      .embedQuery(input.query)
      .pipe(
        Effect.mapError(
          error => new KnowledgeSearchError({ message: error.message, stage: 'embed', cause: error })
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
          error => new KnowledgeSearchError({ message: error.message, stage: 'store', cause: error })
        )
      )
  })

const searchTextChunks = (input: {
  readonly scope: KnowledgeSearchScope
  readonly query: string
  readonly limit: number
}) =>
  Effect.gen(function* () {
    const store = yield* SearchIndexStore
    return yield* store
      .searchChunksByText({ scope: input.scope, query: input.query, limit: input.limit })
      .pipe(
        Effect.mapError(
          error => new KnowledgeSearchError({ message: error.message, stage: 'store', cause: error })
        )
      )
  })

export const searchKnowledge = (input: KnowledgeSearchInput) =>
  Effect.gen(function* () {
    const valid = yield* validateSearchInput(input)
    yield* Effect.annotateCurrentSpan({
      'knowledge_search.query_length': valid.query.length,
      'knowledge_search.limit': valid.limit,
      'knowledge_search.mode': valid.mode,
      'knowledge_search.context_chunks': valid.contextChunks,
      'knowledge_search.scope_count': scopeIds(input.scope).length
    })
    const store = yield* SearchIndexStore
    const results: ReadonlyArray<KnowledgeSearchResult> = valid.mode === 'vector'
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

        return fuseKnowledgeSearchResults({
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
          scopeId: result.chunk.scopeId,
          documentId: result.chunk.documentId,
          position: result.chunk.position,
          contextChunks: valid.contextChunks
        })
        .pipe(
          Effect.map(context => ({ ...result, context })),
          Effect.mapError(
            error => new KnowledgeSearchError({ message: error.message, stage: 'store', cause: error })
          )
        )
    )
  }).pipe(Effect.withSpan('knowledge_search.search'))
