'use server'

import { Effect } from 'effect'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { saveOpenAiCodexToken } from './openai-codex-auth'
import { getSession } from '@/lib/services/auth/get-session'
import { OpenAiCodexOAuth } from '@/lib/services/openai-codex-oauth/live-layer'
import { reportError } from '@/lib/services/telemetry/report-error'

type CheckOpenAiCodexDeviceFlowResult =
  | { readonly _tag: 'Pending' }
  | { readonly _tag: 'Success' }
  | { readonly _tag: 'Failed'; readonly message: string }
  | { readonly _tag: 'Error'; readonly message: string }

export const checkOpenAiCodexDeviceFlowAction = async (input: {
  readonly deviceAuthId: string
  readonly userCode: string
}): Promise<CheckOpenAiCodexDeviceFlowResult> => {
  await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const oauth = yield* OpenAiCodexOAuth

      yield* Effect.annotateCurrentSpan({ 'user.id': session.user.id })

      const pollResult = yield* oauth.pollDeviceFlow(input)

      switch (pollResult._tag) {
        case 'Pending':
          return { _tag: 'Pending' as const }
        case 'Failed':
          return pollResult
        case 'Authorized': {
          const token = yield* oauth.exchangeDeviceToken(pollResult.deviceToken)
          yield* saveOpenAiCodexToken({ userId: session.user.id, token })
          return { _tag: 'Success' as const }
        }
      }
    }).pipe(
      Effect.withSpan('action.agent.openAiCodex.checkDeviceFlow'),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.tapError(error =>
        reportError(error, { operation: 'action.agent.openAiCodex.checkDeviceFlow' })
      ),
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.tap(result =>
        result._tag === 'Success' ? Effect.sync(() => revalidatePath('/agent')) : Effect.void
      ),
      Effect.catch(() =>
        Effect.succeed({
          _tag: 'Error' as const,
          message: 'Could not complete OpenAI Codex connection'
        })
      )
    )
  )
}
