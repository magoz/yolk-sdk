'use server'

import { Data, Effect } from 'effect'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { saveTelegramConnectorConfig } from './telegram-connector'

class TelegramConnectorActionError extends Data.TaggedError('TelegramConnectorActionError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

type SaveTelegramConnectorActionInput = {
  readonly botToken: string
  readonly chatId: string
}

type SaveTelegramConnectorActionResult =
  | { readonly _tag: 'Success'; readonly chatId: string }
  | { readonly _tag: 'Error'; readonly message: string }

export const saveTelegramConnectorAction = async (
  input: SaveTelegramConnectorActionInput
): Promise<SaveTelegramConnectorActionResult> => {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      yield* Effect.annotateCurrentSpan({ 'user.id': session.user.id })
      yield* saveTelegramConnectorConfig({ ...input, userId: session.user.id })
      return { _tag: 'Success' as const, chatId: input.chatId.trim() }
    }).pipe(
      Effect.withSpan('action.agent.telegramConnector.save'),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.catchTag('TelegramConnectorValidationError', error =>
        Effect.succeed({ _tag: 'Error' as const, message: error.message })
      ),
      Effect.tapError(error =>
        reportError(
          new TelegramConnectorActionError({
            message: 'Save Telegram connector failed',
            cause: error
          }),
          { operation: 'action.agent.telegramConnector.save' }
        )
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          revalidatePath('/agent')
          revalidatePath('/agent/connectors')
        })
      ),
      Effect.catch(() =>
        Effect.succeed({ _tag: 'Error' as const, message: 'Could not save Telegram connector' })
      )
    )
  )
}
