'use server'

import { Effect } from 'effect'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { AppRagLayer } from '@/lib/services/rag/live-layer'
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
      yield* createTextStorageObject({
        userId: session.user.id,
        title: input.title,
        content: input.content
      })
    }).pipe(
      Effect.withSpan('action.storage.createText'),
      Effect.provide(AppRagLayer),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.tapError(error => reportError(error, { operation: 'action.storage.createText' })),
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.tap(() => Effect.sync(() => revalidatePath('/storage'))),
      Effect.as({ _tag: 'Success' as const }),
      Effect.catch(() =>
        Effect.succeed({ _tag: 'Error' as const, message: 'Could not create storage object' })
      )
    )
  )
}
