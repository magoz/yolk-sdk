'use server'

import { Effect } from 'effect'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { saveAnthropicClaudeToken } from './anthropic-claude-auth'
import { anthropicClaudeOAuthVerifierCookieName } from './anthropic-claude-oauth-cookie'
import { getSession } from '@/lib/services/auth/get-session'
import { AnthropicClaudeOAuth } from '@/lib/services/anthropic-oauth/live-layer'
import { AnthropicClaudeOAuthError } from '@/lib/services/anthropic-oauth/errors'
import { reportError } from '@/lib/services/telemetry/report-error'

type ExchangeAnthropicClaudeOAuthCodeResult =
  | { readonly _tag: 'Success' }
  | { readonly _tag: 'Error'; readonly message: string }

export const exchangeAnthropicClaudeOAuthCodeAction = async (input: {
  readonly authorizationCode: string
}): Promise<ExchangeAnthropicClaudeOAuthCodeResult> => {
  const cookieStore = await cookies()

  return await NextEffect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const oauth = yield* AnthropicClaudeOAuth
      const codeVerifier = cookieStore.get(anthropicClaudeOAuthVerifierCookieName)?.value

      yield* Effect.annotateCurrentSpan({ 'user.id': session.user.id })

      if (codeVerifier === undefined || codeVerifier.length === 0) {
        return yield* new AnthropicClaudeOAuthError({
          message: 'No Anthropic Claude OAuth flow in progress. Start connection again.'
        })
      }

      const token = yield* oauth.exchangeAuthorizationCode({
        authorizationCode: input.authorizationCode,
        codeVerifier
      })
      yield* saveAnthropicClaudeToken({ userId: session.user.id, token })
      yield* Effect.sync(() => cookieStore.delete(anthropicClaudeOAuthVerifierCookieName))
    }).pipe(
      Effect.withSpan('action.agent.anthropicClaude.exchangeOAuthCode'),
      Effect.provide(AppLayer),
      Effect.scoped,
      Effect.tapError(error =>
        reportError(error, { operation: 'action.agent.anthropicClaude.exchangeOAuthCode' })
      ),
      Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
      Effect.tap(() => Effect.sync(() => revalidatePath('/agent'))),
      Effect.as({ _tag: 'Success' as const }),
      Effect.catchTags({
        AnthropicClaudeOAuthError: error =>
          Effect.succeed({ _tag: 'Error' as const, message: error.message })
      }),
      Effect.catch(() =>
        Effect.succeed({
          _tag: 'Error' as const,
          message: 'Could not complete Anthropic Claude connection'
        })
      )
    )
  )
}
