import { Config, Effect, Redacted } from 'effect'
import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import { TokenBrokerRequest, TokenBrokerResponse } from '@yolk-sdk/oauth'
import { openAiCodexProviderId } from '@yolk-sdk/openai'
import { anthropicClaudeProviderId } from '@yolk-sdk/anthropic'
import { AppLayer } from '@/lib/layers'
import { getValidOpenAiCodexToken } from '@/lib/core/agent/openai-codex-auth'
import { getValidAnthropicClaudeToken } from '@/lib/core/agent/anthropic-claude-auth'

export const dynamic = 'force-dynamic'

const authorizationHeader = 'x-yolk-cloudflare-secret'

const minTtlMsFromSeconds = (seconds: number | undefined) =>
  seconds === undefined ? undefined : Math.max(0, seconds) * 1000

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const secret = yield* Config.redacted('YOLK_CLOUDFLARE_BRIDGE_SECRET')
  const provided = request.headers[authorizationHeader]

  if (provided !== Redacted.value(secret)) {
    return yield* HttpServerResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const input = yield* HttpServerRequest.schemaBodyJson(TokenBrokerRequest)

  if (input.provider === openAiCodexProviderId) {
    const token = yield* getValidOpenAiCodexToken(input.subjectId, {
      minTtlMs: minTtlMsFromSeconds(input.minTtlSeconds),
      forceRefresh: input.forceRefresh
    })

    return yield* HttpServerResponse.json(
      new TokenBrokerResponse({
        provider: openAiCodexProviderId,
        accessToken: token.access,
        expiresAt: token.expires,
        accountId: token.accountId
      })
    )
  }

  if (input.provider === anthropicClaudeProviderId) {
    const token = yield* getValidAnthropicClaudeToken(input.subjectId, {
      minTtlMs: minTtlMsFromSeconds(input.minTtlSeconds),
      forceRefresh: input.forceRefresh
    })

    return yield* HttpServerResponse.json(
      new TokenBrokerResponse({
        provider: anthropicClaudeProviderId,
        accessToken: token.access,
        expiresAt: token.expires
      })
    )
  }

  return yield* HttpServerResponse.json({ error: 'Unsupported provider' }, { status: 400 })
}).pipe(
  Effect.catchTags({
    ConfigError: () => HttpServerResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    HttpServerError: () =>
      HttpServerResponse.json({ error: 'Invalid request body' }, { status: 400 }),
    SchemaError: () => HttpServerResponse.json({ error: 'Invalid request body' }, { status: 400 }),
    OpenAiCodexAuthNotFoundError: () =>
      HttpServerResponse.json({ error: 'OpenAI Codex not connected' }, { status: 409 }),
    OpenAiCodexAuthInvalidError: () =>
      HttpServerResponse.json({ error: 'OpenAI Codex auth invalid' }, { status: 409 }),
    AnthropicClaudeAuthNotFoundError: () =>
      HttpServerResponse.json({ error: 'Anthropic Claude not connected' }, { status: 409 }),
    AnthropicClaudeAuthInvalidError: () =>
      HttpServerResponse.json({ error: 'Anthropic Claude auth invalid' }, { status: 409 }),
    OpenAiCodexOAuthError: error =>
      Effect.logWarning('OpenAI Codex token broker OAuth failed', {
        message: error.message,
        status: error.status
      }).pipe(
        Effect.andThen(
          HttpServerResponse.json(
            {
              error: 'OpenAI Codex OAuth failed',
              detail: error.message,
              upstreamStatus: error.status
            },
            { status: 502 }
          )
        )
      ),
    AnthropicClaudeOAuthError: error =>
      Effect.logWarning('Anthropic Claude token broker OAuth failed', {
        message: error.message,
        status: error.status
      }).pipe(
        Effect.andThen(
          HttpServerResponse.json(
            {
              error: 'Anthropic Claude OAuth failed',
              detail: error.message,
              upstreamStatus: error.status
            },
            { status: 502 }
          )
        )
      )
  }),
  Effect.catch(() => HttpServerResponse.json({ error: 'Internal error' }, { status: 500 }))
)

const { handler: effectHandler } = HttpEffect.toWebHandlerLayer(handler, AppLayer)

export const POST = (request: Request) => effectHandler(request)
