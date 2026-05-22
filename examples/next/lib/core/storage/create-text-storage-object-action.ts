'use server'

import { Effect } from 'effect'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { AppKnowledgeSearchLayer } from '@/lib/services/knowledge-search/live-layer'
import { reportError } from '@/lib/services/telemetry/report-error'
import { createTextStorageObject } from './create-text-storage-object'

export const createTextStorageObjectAction = async (input: {
  readonly title: string
  readonly content: string
}) => {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      yield* Effect.annotateCurrentSpan({
        'user.id': session.user.id,
        'storage.source_type': 'text',
        'storage.title': input.title
      })
      yield* createTextStorageObject({
        userId: session.user.id,
        title: input.title,
        content: input.content
      })
    }).pipe(
      Effect.withSpan('action.storage.createText'),
      Effect.provide(AppKnowledgeSearchLayer),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catchTag('ValidationError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.tapError(error => reportError(error, { operation: 'action.storage.createText' })),
      Effect.tap(() => Effect.sync(() => revalidatePath('/storage'))),
      Effect.as({ _tag: 'Success' as const }),
      Effect.catch(() =>
        Effect.succeed({ _tag: 'Error' as const, message: 'Could not create storage object' })
      )
    )
  )
}
