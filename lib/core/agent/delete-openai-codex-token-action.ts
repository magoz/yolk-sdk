'use server'

import { Effect } from 'effect'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { deleteOpenAiCodexToken } from './openai-codex-auth'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'

type DeleteOpenAiCodexTokenResult =
  | { readonly _tag: 'Success' }
  | { readonly _tag: 'Error'; readonly message: string }

export const deleteOpenAiCodexTokenAction = async (): Promise<DeleteOpenAiCodexTokenResult> => {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      yield* Effect.annotateCurrentSpan({ 'user.id': session.user.id })
      yield* deleteOpenAiCodexToken(session.user.id)
    }).pipe(
      Effect.withSpan('action.agent.openAiCodex.deleteToken'),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.tapError(error =>
        reportError(error, { operation: 'action.agent.openAiCodex.deleteToken' })
      ),
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.tap(() => Effect.sync(() => revalidatePath('/agent'))),
      Effect.as({ _tag: 'Success' as const }),
      Effect.catch(() =>
        Effect.succeed({
          _tag: 'Error' as const,
          message: 'Could not disconnect OpenAI Codex'
        })
      )
    )
  )
}
