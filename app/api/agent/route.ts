import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import { Config, Data, Effect } from 'effect'
import { AppLayer } from '@/lib/layers'
import { makeAgentRuntimeLayer } from '@/lib/agents/runtime-layer'
import { getValidOpenAiCodexToken } from '@/lib/core/agent/openai-codex-auth'
import { makeOpenAiCodexProviderLayer } from '@/lib/agents/providers/openai-codex-provider'
import { OpenAiProviderLayer } from '@/lib/agents/providers/openai-provider'
import { AgentRouteRequest, makeAgentPostResponse } from '@/lib/agents/route-handler'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'

export const dynamic = 'force-dynamic'

class AgentRouteError extends Data.TaggedError('AgentRouteError')<{
  message: string
  cause?: unknown
}> {}

const defaultSystemPrompt = 'You are Yolk assistant. Be concise and practical.'

type AgentProviderMode = 'api_key' | 'codex_oauth'

type AgentRouteRuntimeConfig = {
  readonly provider: AgentProviderMode
  readonly model: string
  readonly systemPrompt: string
}

const RouteLayer = AppLayer

const parseProviderMode = (value: string | undefined) => {
  if (value === undefined || value === 'api_key') {
    return Effect.succeed('api_key' as const)
  }

  if (value === 'codex_oauth') {
    return Effect.succeed('codex_oauth' as const)
  }

  return Effect.fail(
    new AgentRouteError({
      message: `Unsupported OPENAI_PROVIDER: ${value}`
    })
  )
}

const getAgentRouteConfig = () =>
  Effect.gen(function* () {
    const providerConfig = yield* Config.option(Config.string('OPENAI_PROVIDER'))
    const provider = yield* parseProviderMode(
      providerConfig._tag === 'Some' ? providerConfig.value : undefined
    )
    const model = yield* Config.string('OPENAI_MODEL')
    const systemPrompt = yield* Config.option(Config.string('AGENT_SYSTEM_PROMPT'))

    return {
      provider,
      model,
      systemPrompt: systemPrompt._tag === 'Some' ? systemPrompt.value : defaultSystemPrompt
    }
  })

const makeAgentResponseWithProvider = (
  input: AgentRouteRequest,
  config: AgentRouteRuntimeConfig,
  userId: string
) => {
  if (config.provider === 'api_key') {
    return makeAgentPostResponse(input, config).pipe(
      Effect.provide(makeAgentRuntimeLayer(OpenAiProviderLayer))
    )
  }

  return Effect.gen(function* () {
    const token = yield* getValidOpenAiCodexToken(userId)
    const providerLayer = makeOpenAiCodexProviderLayer({ token, fetch: globalThis.fetch })

    return yield* makeAgentPostResponse(input, config).pipe(
      Effect.provide(makeAgentRuntimeLayer(providerLayer))
    )
  })
}

const toHttpResponse = (response: Response) =>
  HttpServerResponse.raw(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries())
  })

const handler = Effect.gen(function* () {
  const session = yield* getSession()
  const input = yield* HttpServerRequest.schemaBodyJson(AgentRouteRequest)
  const config = yield* getAgentRouteConfig()
  const response = yield* makeAgentResponseWithProvider(input, config, session.user.id)

  return toHttpResponse(response)
}).pipe(
  Effect.withSpan('AgentRoute.post'),
  Effect.catchTag('UnauthenticatedError', () =>
    HttpServerResponse.json({ error: 'Unauthorized' }, { status: 401 })
  ),
  Effect.catchTag('HttpServerError', error =>
    reportError(new AgentRouteError({ message: 'Invalid request body', cause: error }), {
      operation: 'agent.route',
      status: 400
    }).pipe(Effect.andThen(HttpServerResponse.json({ error: 'Invalid request body' }, { status: 400 })))
  ),
  Effect.catchTag('SchemaError', error =>
    reportError(new AgentRouteError({ message: 'Invalid request body', cause: error }), {
      operation: 'agent.route',
      status: 400
    }).pipe(Effect.andThen(HttpServerResponse.json({ error: 'Invalid request body' }, { status: 400 })))
  ),
  Effect.catchTag('OpenAiCodexAuthNotFoundError', () =>
    HttpServerResponse.json({ error: 'OpenAI Codex not connected' }, { status: 409 })
  ),
  Effect.catchTag('OpenAiCodexAuthInvalidError', error =>
    reportError(new AgentRouteError({ message: 'OpenAI Codex auth invalid', cause: error }), {
      operation: 'agent.route',
      status: 409
    }).pipe(
      Effect.andThen(HttpServerResponse.json({ error: 'OpenAI Codex auth invalid' }, { status: 409 }))
    )
  ),
  Effect.catchTag('OpenAiCodexOAuthError', error =>
    reportError(new AgentRouteError({ message: 'OpenAI Codex OAuth failed', cause: error }), {
      operation: 'agent.route',
      status: 502
    }).pipe(Effect.andThen(HttpServerResponse.json({ error: 'OpenAI Codex OAuth failed' }, { status: 502 })))
  ),
  Effect.catch(error =>
    reportError(new AgentRouteError({ message: 'Agent request failed', cause: error }), {
      operation: 'agent.route',
      status: 500
    }).pipe(Effect.andThen(HttpServerResponse.json({ error: 'Internal error' }, { status: 500 })))
  )
)

const { handler: effectHandler } = HttpEffect.toWebHandlerLayer(handler, RouteLayer)

export const POST = (request: Request) => effectHandler(request)
