import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/unstable/http'
import { Data, Effect, Layer } from 'effect'
import * as Schema from 'effect/Schema'
import { VercelWorkflows } from '@yolk-sdk/vercel-workflows/effect'
import { AppLayer } from '@/lib/layers'
import { AgentRouteRequest } from '@/lib/agents/route-handler'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { runAgentWorkflow } from '@/lib/agents/workflow-runtime/run-agent-workflow'
import { workflowNdjsonHeaders } from './route-model'

export const dynamic = 'force-dynamic'

class AgentWorkflowRouteError extends Data.TaggedError('AgentWorkflowRouteError')<{
  message: string
  cause?: unknown
}> {}

const handler = Effect.gen(function* () {
  const session = yield* getSession()
  const workflows = yield* VercelWorkflows
  const request = yield* HttpServerRequest.schemaBodyJson(AgentRouteRequest)
  const workflowRequest = yield* Schema.encodeUnknownEffect(AgentRouteRequest)(request)
  const run = yield* workflows.start(runAgentWorkflow, [
    { userId: session.user.id, request: workflowRequest }
  ])
  const readable = yield* run.getReadable<Uint8Array>()

  return HttpServerResponse.raw(readable, {
    status: 200,
    headers: workflowNdjsonHeaders(run.runId)
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

const WorkflowRouteLayer = Layer.merge(AppLayer, VercelWorkflows.layer)

const { handler: effectHandler } = HttpEffect.toWebHandlerLayer(handler, WorkflowRouteLayer)

export const POST = (request: Request) => effectHandler(request)
