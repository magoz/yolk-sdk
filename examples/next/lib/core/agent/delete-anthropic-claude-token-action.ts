'use server'

import { Effect } from 'effect'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { deleteAnthropicClaudeToken } from './anthropic-claude-auth'
import {
  anthropicClaudeOAuthStateCookieName,
  anthropicClaudeOAuthVerifierCookieName
} from './anthropic-claude-oauth-cookie'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'

type DeleteAnthropicClaudeTokenResult =
  | { readonly _tag: 'Success' }
  | { readonly _tag: 'Error'; readonly message: string }

export const deleteAnthropicClaudeTokenAction =
  async (): Promise<DeleteAnthropicClaudeTokenResult> => {
    const cookieStore = await cookies()

    return await NextEffect.runPromise(
      Effect.gen(function* () {
        const session = yield* getSession()
        yield* Effect.annotateCurrentSpan({ 'user.id': session.user.id })
        yield* deleteAnthropicClaudeToken(session.user.id)
        yield* Effect.sync(() => cookieStore.delete(anthropicClaudeOAuthVerifierCookieName))
        yield* Effect.sync(() => cookieStore.delete(anthropicClaudeOAuthStateCookieName))
      }).pipe(
        Effect.withSpan('action.agent.anthropicClaude.deleteToken'),
        Effect.provide(AppLayer),
        Effect.scoped,
        Effect.tapError(error =>
          reportError(error, { operation: 'action.agent.anthropicClaude.deleteToken' })
        ),
        Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
        Effect.tap(() => Effect.sync(() => revalidatePath('/agent'))),
        Effect.as({ _tag: 'Success' as const }),
        Effect.catch(() =>
          Effect.succeed({
            _tag: 'Error' as const,
            message: 'Could not disconnect Anthropic Claude'
          })
        )
      )
    )
  }
