import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import { Data, Effect } from 'effect'
import { AppLayer } from '@/lib/layers'
import { AgentRouteRequest } from '@/lib/agents/route-handler'
import { makeAgentTextResponse } from '@/lib/agents/workflow-runtime/text-response'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'

export const dynamic = 'force-dynamic'

class AgentRouteError extends Data.TaggedError('AgentRouteError')<{
  message: string
  cause?: unknown
}> {}

const RouteLayer = AppLayer

const toHttpResponse = (response: Response) =>
  HttpServerResponse.raw(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries())
  })

const handler = Effect.gen(function* () {
  const session = yield* getSession()
  const input = yield* HttpServerRequest.schemaBodyJson(AgentRouteRequest)
  const response = yield* makeAgentTextResponse(input, session.user.id, '/agent/next')

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
  Effect.catchTag('AgentDocumentLimitError', error =>
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
  Effect.catchTag('AnthropicClaudeAuthNotFoundError', () =>
    HttpServerResponse.json({ error: 'Anthropic Claude not connected' }, { status: 409 })
  ),
  Effect.catchTag('AnthropicClaudeAuthInvalidError', error =>
    reportError(new AgentRouteError({ message: 'Anthropic Claude auth invalid', cause: error }), {
      operation: 'agent.route',
      status: 409
    }).pipe(
      Effect.andThen(
        HttpServerResponse.json({ error: 'Anthropic Claude auth invalid' }, { status: 409 })
      )
    )
  ),
  Effect.catchTag('AnthropicClaudeOAuthError', error =>
    reportError(new AgentRouteError({ message: 'Anthropic Claude OAuth failed', cause: error }), {
      operation: 'agent.route',
      status: 502
    }).pipe(
      Effect.andThen(
        HttpServerResponse.json({ error: 'Anthropic Claude OAuth failed' }, { status: 502 })
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
