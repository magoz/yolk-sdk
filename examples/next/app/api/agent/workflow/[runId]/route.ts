import { Data, Effect } from 'effect'
import { getRun } from 'workflow/api'
import { AppLayer } from '@/lib/layers'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { workflowCancelResponse, workflowResumeResponse } from './route-model'

export const dynamic = 'force-dynamic'

type RouteContext = {
  readonly params: Promise<{ readonly runId: string }>
}

class AgentWorkflowRunRouteError extends Data.TaggedError('AgentWorkflowRunRouteError')<{
  message: string
  cause?: unknown
}> {}

const getRunId = (context: RouteContext) =>
  Effect.promise(() => context.params).pipe(Effect.map(params => params.runId))

const resumeProgram = (context: RouteContext) =>
  Effect.gen(function* () {
    yield* getSession()
    const runId = yield* getRunId(context)
    return workflowResumeResponse(runId, getRun)
  }).pipe(
    Effect.withSpan('AgentWorkflowRunRoute.get'),
    Effect.catchTag('UnauthenticatedError', () =>
      Effect.succeed(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    ),
    Effect.catch(error =>
      reportError(new AgentWorkflowRunRouteError({ message: 'Workflow resume failed', cause: error }), {
        operation: 'agent.workflow.resume',
        status: 500
      }).pipe(Effect.andThen(Effect.succeed(Response.json({ error: 'Internal error' }, { status: 500 }))))
    ),
    Effect.provide(AppLayer)
  )

const cancelProgram = (context: RouteContext) =>
  Effect.gen(function* () {
    yield* getSession()
    const runId = yield* getRunId(context)
    return yield* Effect.promise(() => workflowCancelResponse(runId, getRun))
  }).pipe(
    Effect.withSpan('AgentWorkflowRunRoute.delete'),
    Effect.catchTag('UnauthenticatedError', () =>
      Effect.succeed(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    ),
    Effect.catch(error =>
      reportError(new AgentWorkflowRunRouteError({ message: 'Workflow cancel failed', cause: error }), {
        operation: 'agent.workflow.cancel',
        status: 500
      }).pipe(Effect.andThen(Effect.succeed(Response.json({ error: 'Internal error' }, { status: 500 }))))
    ),
    Effect.provide(AppLayer)
  )

export const GET = (_request: Request, context: RouteContext) => Effect.runPromise(resumeProgram(context))
export const DELETE = (_request: Request, context: RouteContext) =>
  Effect.runPromise(cancelProgram(context))
