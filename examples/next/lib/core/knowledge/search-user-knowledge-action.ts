'use server'

import { Effect, Layer } from 'effect'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { AppKnowledgeSearchLayer } from '@/lib/services/knowledge-search/live-layer'
import { reportError } from '@/lib/services/telemetry/report-error'
import { searchUserKnowledge } from './search-user-knowledge'
import type { KnowledgeSearchActionResult } from './search-user-knowledge-action-result'

const SearchKnowledgeActionLayer = Layer.mergeAll(
  AppLayer,
  AppKnowledgeSearchLayer.pipe(Layer.provide(AppLayer))
)

export const searchUserKnowledgeAction = async (input: {
  readonly query: string
  readonly limit?: number
}): Promise<KnowledgeSearchActionResult> => {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      yield* Effect.annotateCurrentSpan({
        'user.id': session.user.id,
        'knowledge.query_length': input.query.length,
        'knowledge.limit': input.limit ?? 6
      })
      const results = yield* searchUserKnowledge({
        userId: session.user.id,
        query: input.query,
        limit: input.limit,
        contextChunks: 1
      })

      return {
        _tag: 'Success' as const,
        results: results.map(result => ({
          documentId: result.document.id,
          title: result.document.title,
          purpose: result.document.purpose,
          origin: result.document.origin,
          availability: result.document.availability,
          score: result.score,
          vectorScore: result.vectorScore,
          textScore: result.textScore,
          chunkId: result.chunk.id,
          text: result.context.map(chunk => chunk.content).join('\n\n')
        }))
      }
    }).pipe(
      Effect.withSpan('action.knowledge.search'),
      Effect.provide(SearchKnowledgeActionLayer),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catchTag('ValidationError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.catchTag('KnowledgeEmbeddingError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.tapError(error => reportError(error, { operation: 'action.knowledge.search' })),
      Effect.catch(() =>
        Effect.succeed({ _tag: 'Error' as const, message: 'Could not search knowledge' })
      )
    )
  )
}
