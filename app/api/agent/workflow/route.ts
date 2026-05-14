import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import { Data, Effect } from 'effect'
import { start } from 'workflow/api'
import { AppLayer } from '@/lib/layers'
import { AgentRouteRequest } from '@/lib/agents/route-handler'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { runAgentWorkflow } from '@/lib/agents/workflow-runtime/run-agent-workflow'

export const dynamic = 'force-dynamic'

class AgentWorkflowRouteError extends Data.TaggedError('AgentWorkflowRouteError')<{
  message: string
  cause?: unknown
}> {}

const ndjsonHeaders = (runId: string) => ({
  'cache-control': 'no-cache, no-transform',
  'content-type': 'application/x-ndjson; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'x-workflow-run-id': runId
})

const handler = Effect.gen(function* () {
  const session = yield* getSession()
  const request = yield* HttpServerRequest.schemaBodyJson(AgentRouteRequest)
  const run = yield* Effect.promise(() =>
    start(runAgentWorkflow, [{ userId: session.user.id, request }])
  )

  return HttpServerResponse.raw(run.getReadable<Uint8Array>(), {
    status: 200,
    headers: ndjsonHeaders(run.runId)
  })
}).pipe(
  Effect.withSpan('AgentWorkflowRoute.post'),
  Effect.catchTag('UnauthenticatedError', () =>
    HttpServerResponse.json({ error: 'Unauthorized' }, { status: 401 })
  ),
  Effect.catchTag('HttpServerError', error =>
    reportError(new AgentWorkflowRouteError({ message: 'Invalid request body', cause: error }), {
      operation: 'agent.workflow.route',
      status: 400
    }).pipe(
      Effect.andThen(HttpServerResponse.json({ error: 'Invalid request body' }, { status: 400 }))
    )
  ),
  Effect.catchTag('SchemaError', error =>
    reportError(new AgentWorkflowRouteError({ message: 'Invalid request body', cause: error }), {
      operation: 'agent.workflow.route',
      status: 400
    }).pipe(
      Effect.andThen(HttpServerResponse.json({ error: 'Invalid request body' }, { status: 400 }))
    )
  ),
  Effect.catch(error =>
    reportError(new AgentWorkflowRouteError({ message: 'Workflow start failed', cause: error }), {
      operation: 'agent.workflow.route',
      status: 500
    }).pipe(Effect.andThen(HttpServerResponse.json({ error: 'Internal error' }, { status: 500 })))
  )
)

const { handler: effectHandler } = HttpEffect.toWebHandlerLayer(handler, AppLayer)

export const POST = (request: Request) => effectHandler(request)
