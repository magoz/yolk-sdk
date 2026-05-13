import { Config, Effect, Redacted } from 'effect'
import * as Schema from 'effect/Schema'
import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import { AppLayer } from '@/lib/layers'
import { getValidOpenAiCodexToken } from '@/lib/core/agent/openai-codex-auth'

export const dynamic = 'force-dynamic'

const CodexTokenRequest = Schema.Struct({
  userId: Schema.String
})

const authorizationHeader = 'x-yolk-cloudflare-secret'

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const secret = yield* Config.redacted('YOLK_CLOUDFLARE_BRIDGE_SECRET')
  const provided = request.headers[authorizationHeader]

  if (provided !== Redacted.value(secret)) {
    return yield* HttpServerResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const input = yield* HttpServerRequest.schemaBodyJson(CodexTokenRequest)
  const token = yield* getValidOpenAiCodexToken(input.userId)

  return yield* HttpServerResponse.json(
    token.accountId === undefined
      ? { access: token.access, expires: token.expires }
      : { access: token.access, expires: token.expires, accountId: token.accountId }
  )
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
    OpenAiCodexOAuthError: () =>
      HttpServerResponse.json({ error: 'OpenAI Codex OAuth failed' }, { status: 502 })
  }),
  Effect.catch(() => HttpServerResponse.json({ error: 'Internal error' }, { status: 500 }))
)

const { handler: effectHandler } = HttpEffect.toWebHandlerLayer(handler, AppLayer)

export const POST = (request: Request) => effectHandler(request)
