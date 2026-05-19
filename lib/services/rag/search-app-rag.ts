import { Effect } from 'effect'
import { and, eq, inArray } from 'drizzle-orm'
import { retrieveRag } from '@yolk-sdk/rag/retrieval'
import type { RagSearchScope } from '@yolk-sdk/rag/documents'
import { Db } from '@/lib/services/db/live-layer'
import * as schema from '@/lib/services/db/schema'
import {
  AppRagSearchError,
  AppRagSetNotFoundError,
  isAppRagSearchError,
  isAppRagSetNotFoundError
} from './errors'

const DEFAULT_LIMIT = 10
const DEFAULT_MIN_SCORE = 0.5
const DEFAULT_CONTEXT_CHUNKS = 0

export type SearchAppRagOptions = {
  readonly limit?: number
  readonly minScore?: number
  readonly contextChunks?: number
}

const scopeIds = (scope: RagSearchScope): ReadonlyArray<string> => {
  switch (scope._tag) {
    case 'RagSet':
      return [scope.id]
    case 'RagSets':
      return scope.ids
  }
}

const ensureUserOwnsScope = (input: { readonly userId: string; readonly scope: RagSearchScope }) =>
  Effect.gen(function* () {
    const ids = scopeIds(input.scope)

    if (ids.length === 0) {
      return
    }

    const db = yield* Db
    const rows = yield* db
      .select({ id: schema.ragSet.id })
      .from(schema.ragSet)
      .where(and(inArray(schema.ragSet.id, [...ids]), eq(schema.ragSet.userId, input.userId)))

    const ownedIds = new Set(rows.map(row => row.id))
    const missingId = ids.find(id => !ownedIds.has(id))

    if (missingId !== undefined) {
      return yield* Effect.fail(
        new AppRagSetNotFoundError({ message: 'RAG set not found', ragSetId: missingId })
      )
    }
  })

const mapSearchError = (error: unknown) => {
  if (isAppRagSearchError(error) || isAppRagSetNotFoundError(error)) {
    return error
  }

  return new AppRagSearchError({ message: 'Could not search RAG', stage: 'store', cause: error })
}

export const searchAppRag = (input: {
  readonly userId: string
  readonly scope: RagSearchScope
  readonly query: string
  readonly options?: SearchAppRagOptions
}) => {
  const options = input.options ?? {}
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE

  if (!Number.isFinite(minScore)) {
    return Effect.fail(
      new AppRagSearchError({ message: 'Search minScore must be finite', stage: 'store' })
    )
  }

  return Effect.gen(function* () {
    yield* ensureUserOwnsScope({ userId: input.userId, scope: input.scope })

    return yield* retrieveRag({
      scope: input.scope,
      query: input.query,
      limit: options.limit ?? DEFAULT_LIMIT,
      minScore,
      contextChunks: options.contextChunks ?? DEFAULT_CONTEXT_CHUNKS
    }).pipe(
      Effect.mapError(
        error => new AppRagSearchError({ message: error.message, stage: error.stage, cause: error })
      )
    )
  }).pipe(
    Effect.withSpan('rag.search'),
    Effect.mapError(mapSearchError)
  )
}
