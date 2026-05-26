'use server'

import { Effect } from 'effect'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { updateKnowledgeContextPolicy } from './update-knowledge-context-policy'

export const updateKnowledgeContextPolicyAction = async (input: {
  readonly id: string
  readonly contextPolicy: 'pinned' | 'routable' | 'searchable' | 'archived'
}) => {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      yield* updateKnowledgeContextPolicy({ userId: session.user.id, ...input })
    }).pipe(
      Effect.withSpan('action.knowledge.updateContextPolicy'),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.tap(() => Effect.sync(() => revalidatePath('/knowledge'))),
      Effect.as({ _tag: 'Success' as const }),
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catchTag('NotFoundError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.tapError(error => reportError(error, { operation: 'action.knowledge.updateContextPolicy' })),
      Effect.catch(() => Effect.succeed({ _tag: 'Error' as const, message: 'Could not update knowledge record' }))
    )
  )
}
