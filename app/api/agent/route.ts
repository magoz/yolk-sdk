import {
  FetchHttpClient,
  HttpEffect,
  HttpServerRequest,
  HttpServerResponse
} from 'effect/unstable/http'
import { Config, Data, Effect, Layer } from 'effect'
import { makeToolExecutorLayer, type ResolvedToolSet } from '@yolk/tool-registry'
import {
  type AgentModelCapabilities,
  type AgentReasoningEffort,
  type ToolDef
} from '@yolk/protocol'
import { AppLayer } from '@/lib/layers'
import { makeAgentRuntimeLayerWithTools } from '@/lib/agents/runtime-layer'
import {
  agentTextModel,
  agentTextCapabilities,
  agentTextReasoningEffort,
  defaultAgentSystemPrompt
} from '@/lib/agents/text-agent-config'
import { getValidOpenAiCodexToken } from '@/lib/core/agent/openai-codex-auth'
import { makeOpenAiCodexProviderLayer } from '@/lib/agents/providers/openai-codex-provider'
import { AgentRouteRequest, makeAgentPostResponse } from '@/lib/agents/route-handler'
import { resolveAgentTools } from '@/lib/agents/tools/registry'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'

export const dynamic = 'force-dynamic'

class AgentRouteError extends Data.TaggedError('AgentRouteError')<{
  message: string
  cause?: unknown
}> {}

type AgentRouteRuntimeConfig = {
  readonly model: string
  readonly reasoningEffort: AgentReasoningEffort
  readonly systemPrompt: string
  readonly tools: ReadonlyArray<ToolDef>
  readonly capabilities: AgentModelCapabilities
}

const RouteLayer = AppLayer

const getAgentRouteConfig = () =>
  Effect.gen(function* () {
    const systemPrompt = yield* Config.option(Config.string('AGENT_SYSTEM_PROMPT'))

    return {
      model: agentTextModel,
      reasoningEffort: agentTextReasoningEffort,
      systemPrompt: systemPrompt._tag === 'Some' ? systemPrompt.value : defaultAgentSystemPrompt
    }
  })

const makeAgentResponseWithProvider = (
  input: AgentRouteRequest,
  config: AgentRouteRuntimeConfig,
  toolSet: ResolvedToolSet,
  userId: string
) =>
  Effect.gen(function* () {
    const token = yield* getValidOpenAiCodexToken(userId)
    const providerLayer = makeOpenAiCodexProviderLayer({ token }).pipe(
      Layer.provide(FetchHttpClient.layer)
    )

    return yield* makeAgentPostResponse(input, config).pipe(
      Effect.provide(makeAgentRuntimeLayerWithTools(providerLayer, makeToolExecutorLayer(toolSet)))
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
  const baseConfig = yield* getAgentRouteConfig()
  const toolSet = yield* resolveAgentTools({
    surface: 'text',
    route: '/agent',
    userId: session.user.id
  })
  const response = yield* makeAgentResponseWithProvider(
    input,
    { ...baseConfig, tools: toolSet.tools, capabilities: agentTextCapabilities },
    toolSet,
    session.user.id
  )

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
    }).pipe(
      Effect.andThen(HttpServerResponse.json({ error: 'Invalid request body' }, { status: 400 }))
    )
  ),
  Effect.catchTag('SchemaError', error =>
    reportError(new AgentRouteError({ message: 'Invalid request body', cause: error }), {
      operation: 'agent.route',
      status: 400
    }).pipe(
      Effect.andThen(HttpServerResponse.json({ error: 'Invalid request body' }, { status: 400 }))
    )
  ),
  Effect.catchTag('AgentImageLimitError', error =>
    HttpServerResponse.json({ error: error.message }, { status: 400 })
  ),
  Effect.catchTag('OpenAiCodexAuthNotFoundError', () =>
    HttpServerResponse.json({ error: 'OpenAI Codex not connected' }, { status: 409 })
  ),
  Effect.catchTag('OpenAiCodexAuthInvalidError', error =>
    reportError(new AgentRouteError({ message: 'OpenAI Codex auth invalid', cause: error }), {
      operation: 'agent.route',
      status: 409
    }).pipe(
      Effect.andThen(
        HttpServerResponse.json({ error: 'OpenAI Codex auth invalid' }, { status: 409 })
      )
    )
  ),
  Effect.catchTag('OpenAiCodexOAuthError', error =>
    reportError(new AgentRouteError({ message: 'OpenAI Codex OAuth failed', cause: error }), {
      operation: 'agent.route',
      status: 502
    }).pipe(
      Effect.andThen(
        HttpServerResponse.json({ error: 'OpenAI Codex OAuth failed' }, { status: 502 })
      )
    )
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
