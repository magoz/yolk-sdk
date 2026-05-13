import { Config, Effect, Redacted } from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpEffect,
  HttpServerRequest,
  HttpServerResponse
} from 'effect/unstable/http'
import { AppLayer } from '@/lib/layers'
import { openAiCodexResponsesUrl } from '@/lib/agents/providers/openai-codex-provider'
import { forwardedHeaders } from './route-model'

export const dynamic = 'force-dynamic'

const bridgeSecretHeader = 'x-yolk-cloudflare-secret'

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const secret = yield* Config.redacted('YOLK_CLOUDFLARE_BRIDGE_SECRET')
  const provided = request.headers[bridgeSecretHeader]

  if (provided !== Redacted.value(secret)) {
    return yield* HttpServerResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const client = yield* HttpClient.HttpClient
  const body = yield* request.text
  const response = yield* client.execute(
    HttpClientRequest.post(openAiCodexResponsesUrl).pipe(
      HttpClientRequest.setHeaders(forwardedHeaders(request.headers)),
      HttpClientRequest.bodyText(body, request.headers['content-type'] ?? 'application/json')
    )
  )
  const responseBody = yield* response.text

  return HttpServerResponse.text(responseBody, {
    status: response.status,
    headers: {
      'content-type': response.headers['content-type'] ?? 'text/plain'
    }
  })
}).pipe(
  Effect.provide(FetchHttpClient.layer),
  Effect.catchTags({
    ConfigError: () => HttpServerResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    HttpServerError: () =>
      HttpServerResponse.json({ error: 'Invalid request body' }, { status: 400 }),
    HttpClientError: () =>
      HttpServerResponse.json({ error: 'OpenAI Codex request failed' }, { status: 502 })
  }),
  Effect.catch(() => HttpServerResponse.json({ error: 'Internal error' }, { status: 500 }))
)

const { handler: effectHandler } = HttpEffect.toWebHandlerLayer(handler, AppLayer)

export const POST = (request: Request) => effectHandler(request)
