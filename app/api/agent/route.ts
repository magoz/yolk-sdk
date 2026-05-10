import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import { Config, Data, Effect } from 'effect'
import type { LLMError } from '@yolk/agent-loop'
import { AppLayer } from '@/lib/layers'
import { makeAgentRuntimeLayer } from '@/lib/agents/runtime-layer'
import { getValidOpenAiCodexToken } from '@/lib/core/agent/openai-codex-auth'
import { makeOpenAiCodexProviderLayer } from '@/lib/agents/providers/openai-codex-provider'
import { AgentRouteRequest, makeAgentPostResponse } from '@/lib/agents/route-handler'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'

export const dynamic = 'force-dynamic'

class AgentRouteError extends Data.TaggedError('AgentRouteError')<{
  message: string
  cause?: unknown
}> {}

const llmStatus = (error: LLMError) => {
  switch (error.cause) {
    case 'rate_limit':
      return 429
    case 'context_overflow':
      return 413
    case 'invalid_response':
    case 'provider_error':
      return 502
  }
}

const defaultSystemPrompt = 'You are Yolk assistant. Be concise and practical.'
const agentModel = 'gpt-5.4'

type AgentRouteRuntimeConfig = {
  readonly model: string
  readonly systemPrompt: string
}

const RouteLayer = AppLayer

const getAgentRouteConfig = () =>
  Effect.gen(function* () {
    const systemPrompt = yield* Config.option(Config.string('AGENT_SYSTEM_PROMPT'))

    return {
      model: agentModel,
      systemPrompt: systemPrompt._tag === 'Some' ? systemPrompt.value : defaultSystemPrompt
    }
  })

const makeAgentResponseWithProvider = (
  input: AgentRouteRequest,
  config: AgentRouteRuntimeConfig,
  userId: string
) =>
  Effect.gen(function* () {
    const token = yield* getValidOpenAiCodexToken(userId)
    const providerLayer = makeOpenAiCodexProviderLayer({ token, fetch: globalThis.fetch })

    return yield* makeAgentPostResponse(input, config).pipe(
      Effect.provide(makeAgentRuntimeLayer(providerLayer))
    )
  })

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
  Effect.catchTag('LLMError', error => {
    const status = llmStatus(error)
    return reportError(new AgentRouteError({ message: error.message, cause: error }), {
      operation: 'agent.route',
      status
    }).pipe(Effect.andThen(HttpServerResponse.json({ error: error.message }, { status })))
  }),
  Effect.catch(error =>
    reportError(new AgentRouteError({ message: 'Agent request failed', cause: error }), {
      operation: 'agent.route',
      status: 500
    }).pipe(Effect.andThen(HttpServerResponse.json({ error: 'Internal error' }, { status: 500 })))
  )
)

const { handler: effectHandler } = HttpEffect.toWebHandlerLayer(handler, RouteLayer)

export const POST = (request: Request) => effectHandler(request)
