'use server'

import { Effect } from 'effect'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { updateKnowledgeAvailability } from './update-knowledge-availability'
import type { KnowledgeAvailability } from './availability'

export const updateKnowledgeAvailabilityAction = async (input: {
  readonly id: string
  readonly availability: KnowledgeAvailability
}) => {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      yield* Effect.annotateCurrentSpan({
        'user.id': session.user.id,
        'knowledge.document_id': input.id,
        'knowledge.availability': input.availability
      })
      yield* updateKnowledgeAvailability({ userId: session.user.id, ...input })
    }).pipe(
      Effect.withSpan('action.knowledge.updateAvailability'),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.tap(() => Effect.sync(() => revalidatePath('/knowledge'))),
      Effect.as({ _tag: 'Success' as const }),
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catchTag('NotFoundError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.tapError(error =>
        reportError(error, { operation: 'action.knowledge.updateAvailability' })
      ),
      Effect.catch(() =>
        Effect.succeed({
          _tag: 'Error' as const,
          message: 'Could not update knowledge availability'
        })
      )
    )
  )
}
