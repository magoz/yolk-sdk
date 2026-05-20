'use server'

import { Effect, Layer } from 'effect'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { AppRagLayer } from '@/lib/services/rag/live-layer'
import { reportError } from '@/lib/services/telemetry/report-error'
import { searchUserKnowledge } from './search-user-knowledge'

const SearchKnowledgeActionLayer = Layer.mergeAll(
  AppLayer,
  AppRagLayer.pipe(Layer.provide(AppLayer))
)

export type KnowledgeSearchActionResult =
  | {
      readonly _tag: 'Success'
      readonly results: ReadonlyArray<{
        readonly objectId: string
        readonly title: string
        readonly role: string
        readonly contextPolicy: string
        readonly score: number
        readonly vectorScore?: number
        readonly textScore?: number
        readonly chunkId: string
        readonly text: string
      }>
    }
  | { readonly _tag: 'Error'; readonly message: string }

export const searchUserKnowledgeAction = async (input: {
  readonly query: string
  readonly limit?: number
}): Promise<KnowledgeSearchActionResult> => {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const results = yield* searchUserKnowledge({
        userId: session.user.id,
        query: input.query,
        limit: input.limit,
        contextChunks: 1
      })

      return {
        _tag: 'Success' as const,
        results: results.map(result => ({
          objectId: result.object.id,
          title: result.object.title,
          role: result.object.role,
          contextPolicy: result.object.contextPolicy,
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
      Effect.catchTag('RagEmbeddingError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.tapError(error => reportError(error, { operation: 'action.knowledge.search' })),
      Effect.catch(() => Effect.succeed({ _tag: 'Error' as const, message: 'Could not search knowledge' }))
    )
  )
}
