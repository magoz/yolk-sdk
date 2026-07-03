'use server'

import { Data, Effect } from 'effect'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { deleteTelegramConnectorConfig } from './telegram-connector'

class TelegramConnectorActionError extends Data.TaggedError('TelegramConnectorActionError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

type DeleteTelegramConnectorActionResult =
  | { readonly _tag: 'Success' }
  | { readonly _tag: 'Error'; readonly message: string }

export const deleteTelegramConnectorAction =
  async (): Promise<DeleteTelegramConnectorActionResult> => {
    await cookies()

    return await NextEffect.runPromise(
      Effect.gen(function* () {
        const session = yield* getSession()
        yield* Effect.annotateCurrentSpan({ 'user.id': session.user.id })
        yield* deleteTelegramConnectorConfig(session.user.id)
      }).pipe(
        Effect.withSpan('action.agent.telegramConnector.delete'),
        Effect.provide(AppLayer),
        Effect.scoped,
        Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
        Effect.tapError(error =>
          reportError(
            new TelegramConnectorActionError({
              message: 'Delete Telegram connector failed',
              cause: error
            }),
            { operation: 'action.agent.telegramConnector.delete' }
          )
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            revalidatePath('/agent')
            revalidatePath('/agent/connectors')
          })
        ),
        Effect.as({ _tag: 'Success' as const }),
        Effect.catch(() =>
          Effect.succeed({ _tag: 'Error' as const, message: 'Could not disconnect Telegram' })
        )
      )
    )
  }
