'use server'

import { Effect } from 'effect'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { OpenAiCodexOAuth } from '@/lib/services/openai-codex-oauth/live-layer'
import { reportError } from '@/lib/services/telemetry/report-error'

type StartOpenAiCodexDeviceFlowResult =
  | {
      readonly _tag: 'Success'
      readonly userCode: string
      readonly verificationUrl: string
      readonly deviceAuthId: string
      readonly interval: number
    }
  | { readonly _tag: 'Error'; readonly message: string }

export const startOpenAiCodexDeviceFlowAction =
  async (): Promise<StartOpenAiCodexDeviceFlowResult> => {
    await cookies()

    return await NextEffect.runPromise(
      Effect.gen(function* () {
        const session = yield* getSession()
        const oauth = yield* OpenAiCodexOAuth

        yield* Effect.annotateCurrentSpan({ 'user.id': session.user.id })

        const deviceFlow = yield* oauth.startDeviceFlow()

        return { _tag: 'Success' as const, ...deviceFlow }
      }).pipe(
        Effect.withSpan('action.agent.openAiCodex.startDeviceFlow'),
        Effect.provide(AppLayer),
        Effect.scoped,
        Effect.tapError(error =>
          reportError(error, { operation: 'action.agent.openAiCodex.startDeviceFlow' })
        ),
        Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
        Effect.catch(() =>
          Effect.succeed({
            _tag: 'Error' as const,
            message: 'Could not start OpenAI Codex connection'
          })
        )
      )
    )
  }
