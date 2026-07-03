'use server'

import { Effect } from 'effect'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { deleteStorageObject } from './delete-storage-object'

export const deleteStorageObjectAction = async (input: { readonly id: string }) => {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      yield* Effect.annotateCurrentSpan({
        'user.id': session.user.id,
        'storage.object_id': input.id
      })
      yield* deleteStorageObject({ id: input.id, userId: session.user.id })
    }).pipe(
      Effect.withSpan('action.storage.delete'),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catchTag('NotFoundError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.tapError(error => reportError(error, { operation: 'action.storage.delete' })),
      Effect.tap(() => Effect.sync(() => revalidatePath('/storage'))),
      Effect.as({ _tag: 'Success' as const }),
      Effect.catch(() =>
        Effect.succeed({ _tag: 'Error' as const, message: 'Could not delete storage source' })
      )
    )
  )
}
