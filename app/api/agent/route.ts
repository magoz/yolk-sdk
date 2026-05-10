import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import { Config, Data, Effect, Layer } from 'effect'
import { AgentRuntimeLayer } from '@/lib/agents/runtime-layer'
import { AgentRouteRequest, makeAgentPostResponse } from '@/lib/agents/route-handler'
import { getSession } from '@/lib/services/auth/get-session'
import { Auth } from '@/lib/services/auth/live-layer'
import { reportError } from '@/lib/services/telemetry/report-error'

export const dynamic = 'force-dynamic'

class AgentRouteError extends Data.TaggedError('AgentRouteError')<{
  message: string
  cause?: unknown
}> {}

const defaultSystemPrompt = 'You are Yolk assistant. Be concise and practical.'

const RouteLayer = Layer.mergeAll(Auth.layer, AgentRuntimeLayer)

const getAgentRouteConfig = () =>
  Effect.gen(function* () {
    const model = yield* Config.string('ANTHROPIC_MODEL')
    const systemPrompt = yield* Config.option(Config.string('AGENT_SYSTEM_PROMPT'))

    return {
      model,
      systemPrompt: systemPrompt._tag === 'Some' ? systemPrompt.value : defaultSystemPrompt
    }
  })

const toHttpResponse = (response: Response) =>
  HttpServerResponse.raw(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries())
  })

const handler = Effect.gen(function* () {
  yield* getSession()
  const input = yield* HttpServerRequest.schemaBodyJson(AgentRouteRequest)
  const config = yield* getAgentRouteConfig()
  const response = yield* makeAgentPostResponse(input, config)

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
  Effect.catch(error =>
    reportError(new AgentRouteError({ message: 'Agent request failed', cause: error }), {
      operation: 'agent.route',
      status: 500
    }).pipe(Effect.andThen(HttpServerResponse.json({ error: 'Internal error' }, { status: 500 })))
  )
)

const { handler: effectHandler } = HttpEffect.toWebHandlerLayer(handler, RouteLayer)

export const POST = (request: Request) => effectHandler(request)
