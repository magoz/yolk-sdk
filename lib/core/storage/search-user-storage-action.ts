'use server'

import { Effect } from 'effect'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { AppRagLayer } from '@/lib/services/rag/live-layer'
import { reportError } from '@/lib/services/telemetry/report-error'
import { searchUserStorage } from './search-user-storage'

export const searchUserStorageAction = async (input: {
  readonly query: string
  readonly limit?: number
  readonly contextChunks?: number
}) => {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      yield* Effect.annotateCurrentSpan({
        'user.id': session.user.id,
        'storage.query_length': input.query.length
      })
      return yield* searchUserStorage({
        userId: session.user.id,
        query: input.query,
        limit: input.limit,
        contextChunks: input.contextChunks
      })
    }).pipe(
      Effect.withSpan('action.storage.search'),
      Effect.provide(AppRagLayer),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.map(result => ({ _tag: 'Success' as const, result })),
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catchTag('ValidationError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.tapError(error => reportError(error, { operation: 'action.storage.search' })),
      Effect.catch(() => Effect.succeed({ _tag: 'Error' as const, message: 'Could not search storage' }))
    )
  )
}
