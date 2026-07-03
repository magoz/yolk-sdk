import { Effect } from 'effect'
import { and, eq, inArray } from 'drizzle-orm'
import { searchKnowledge } from '@yolk-sdk/knowledge/search'
import type { KnowledgeSearchScope } from '@yolk-sdk/knowledge/documents'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import {
  AppKnowledgeSearchError,
  AppKnowledgeCollectionNotFoundError,
  isAppKnowledgeSearchError,
  isAppKnowledgeCollectionNotFoundError
} from './errors'

const DEFAULT_LIMIT = 10
const DEFAULT_MIN_SCORE = 0.5
const DEFAULT_CONTEXT_CHUNKS = 0

export type SearchAppKnowledgeOptions = {
  readonly limit?: number
  readonly minScore?: number
  readonly contextChunks?: number
}

const scopeIds = (scope: KnowledgeSearchScope): ReadonlyArray<string> => {
  switch (scope._tag) {
    case 'KnowledgeScope':
      return [scope.id]
    case 'KnowledgeScopes':
      return scope.ids
  }
}

const ensureUserOwnsScope = (input: {
  readonly userId: string
  readonly scope: KnowledgeSearchScope
}) =>
  Effect.gen(function* () {
    const ids = scopeIds(input.scope)

    if (ids.length === 0) {
      return
    }

    const db = yield* Db
    const rows = yield* db
      .select({ id: schema.knowledgeCollection.id })
      .from(schema.knowledgeCollection)
      .where(
        and(
          inArray(schema.knowledgeCollection.id, [...ids]),
          eq(schema.knowledgeCollection.userId, input.userId)
        )
      )

    const ownedIds = new Set(rows.map(row => row.id))
    const missingId = ids.find(id => !ownedIds.has(id))

    if (missingId !== undefined) {
      return yield* Effect.fail(
        new AppKnowledgeCollectionNotFoundError({
          message: 'knowledge collection not found',
          collectionId: missingId
        })
      )
    }
  })

const mapSearchError = (error: unknown) => {
  if (isAppKnowledgeSearchError(error) || isAppKnowledgeCollectionNotFoundError(error)) {
    return error
  }

  return new AppKnowledgeSearchError({
    message: 'Could not search knowledge search',
    stage: 'store',
    cause: error
  })
}

export const searchAppKnowledge = (input: {
  readonly userId: string
  readonly scope: KnowledgeSearchScope
  readonly query: string
  readonly options?: SearchAppKnowledgeOptions
}) => {
  const options = input.options ?? {}
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE

  if (!Number.isFinite(minScore)) {
    return Effect.fail(
      new AppKnowledgeSearchError({ message: 'Search minScore must be finite', stage: 'store' })
    )
  }

  return Effect.gen(function* () {
    yield* ensureUserOwnsScope({ userId: input.userId, scope: input.scope })

    return yield* searchKnowledge({
      scope: input.scope,
      query: input.query,
      limit: options.limit ?? DEFAULT_LIMIT,
      minScore,
      contextChunks: options.contextChunks ?? DEFAULT_CONTEXT_CHUNKS
    }).pipe(
      Effect.mapError(
        error =>
          new AppKnowledgeSearchError({ message: error.message, stage: error.stage, cause: error })
      )
    )
  }).pipe(Effect.withSpan('knowledge_search.search'), Effect.mapError(mapSearchError))
}
