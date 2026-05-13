'use server'

import { createHash, randomBytes } from 'node:crypto'
import { Effect } from 'effect'
import { cookies } from 'next/headers'
import { makeAnthropicClaudeAuthorizationUrl } from '@yolk/anthropic'
import { AppLayer } from '@/lib/layers'
import { NextEffect } from '@/lib/next-effect'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'

const verifierCookieName = 'yolk_anthropic_claude_oauth_verifier'
const verifierMaxAgeSeconds = 10 * 60

const generateCodeVerifier = () => randomBytes(32).toString('base64url')

const generateCodeChallenge = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url')

type StartAnthropicClaudeOAuthResult =
  | {
      readonly _tag: 'Success'
      readonly authUrl: string
    }
  | { readonly _tag: 'Error'; readonly message: string }

export const startAnthropicClaudeOAuthAction =
  async (): Promise<StartAnthropicClaudeOAuthResult> => {
    const cookieStore = await cookies()

    return await NextEffect.runPromise(
      Effect.gen(function* () {
        const session = yield* getSession()
        const codeVerifier = generateCodeVerifier()
        const codeChallenge = generateCodeChallenge(codeVerifier)

        yield* Effect.annotateCurrentSpan({ 'user.id': session.user.id })
        yield* Effect.sync(() =>
          cookieStore.set(verifierCookieName, codeVerifier, {
            httpOnly: true,
            maxAge: verifierMaxAgeSeconds,
            path: '/',
            sameSite: 'lax'
          })
        )

        return {
          _tag: 'Success' as const,
          authUrl: makeAnthropicClaudeAuthorizationUrl({
            codeChallenge,
            state: codeVerifier
          })
        }
      }).pipe(
        Effect.withSpan('action.agent.anthropicClaude.startOAuth'),
        Effect.provide(AppLayer),
        Effect.scoped,
        Effect.tapError(error =>
          reportError(error, { operation: 'action.agent.anthropicClaude.startOAuth' })
        ),
        Effect.catchTag('UnauthenticatedError', () => NextEffect.redirect('/login')),
        Effect.catch(() =>
          Effect.succeed({
            _tag: 'Error' as const,
            message: 'Could not start Anthropic Claude connection'
          })
        )
      )
    )
  }

export const anthropicClaudeOAuthVerifierCookieName = verifierCookieName
