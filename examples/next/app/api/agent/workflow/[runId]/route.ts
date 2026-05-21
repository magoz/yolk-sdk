import { Data, Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { HitlResponse } from '@yolk-sdk/agent/protocol'
import { getRun, resumeHook } from 'workflow/api'
import { AppLayer } from '@/lib/layers'
import { AgentRouteRequest } from '@/lib/agents/route-handler'
import { agentWorkflowHitlHookToken } from '@/lib/agents/workflow-runtime/run-agent-workflow'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import { workflowCancelResponse, workflowResumeResponse } from './route-model'
import { workflowReadableTailIndex } from '../route-model'

export const dynamic = 'force-dynamic'

type RouteContext = {
  readonly params: Promise<{ readonly runId: string }>
}

class AgentWorkflowRunRouteError extends Data.TaggedError('AgentWorkflowRunRouteError')<{
  message: string
  cause?: unknown
}> {}

class AgentWorkflowHitlRequestError extends Data.TaggedError('AgentWorkflowHitlRequestError')<{
  message: string
  cause?: unknown
}> {}

const invalidHitlRequest = (message: string, cause?: unknown) =>
  new AgentWorkflowHitlRequestError({ message, cause })

const getRunId = (context: RouteContext) =>
  Effect.promise(() => context.params).pipe(Effect.map(params => params.runId))

const readRequestJson = (request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: error => invalidHitlRequest('Invalid request body', error)
  })

const firstHitlResponse = (request: AgentRouteRequest) => {
  const response = request.hitlResponses?.[0]
  const extra = request.hitlResponses?.[1]

  if (response === undefined) {
    return Effect.fail(invalidHitlRequest('Missing HITL response'))
  }

  if (extra !== undefined) {
    return Effect.fail(invalidHitlRequest('Workflow HITL resume accepts one response'))
  }

  return Effect.succeed(response)
}

const decodeHitlRequest = (request: Request) =>
  readRequestJson(request).pipe(
    Effect.flatMap(body => Schema.decodeUnknownEffect(AgentRouteRequest)(body)),
    Effect.mapError(error => invalidHitlRequest('Invalid HITL request body', error))
  )

const encodeHitlResponse = (response: HitlResponse) =>
  Schema.encodeUnknownEffect(HitlResponse)(response).pipe(
    Effect.mapError(error => invalidHitlRequest('Invalid HITL response', error))
  )

const parseStartIndex = (request: Request) => {
  const raw = new URL(request.url).searchParams.get('startIndex')

  if (raw === null) {
    return undefined
  }

  const parsed = Number.parseInt(raw, 10)

  return Number.isFinite(parsed) ? parsed : undefined
}

const currentWorkflowTailIndex = (runId: string) =>
  Effect.tryPromise({
    try: () => workflowReadableTailIndex(getRun(runId).getReadable<Uint8Array>({ startIndex: -1 })),
    catch: error =>
      new AgentWorkflowRunRouteError({ message: 'Workflow stream cursor failed', cause: error })
  })

const resumeProgram = (request: Request, context: RouteContext) =>
  Effect.gen(function* () {
    yield* getSession()
    const runId = yield* getRunId(context)
    return workflowResumeResponse(runId, getRun, { startIndex: parseStartIndex(request) })
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

const hitlResumeProgram = (request: Request, context: RouteContext) =>
  Effect.gen(function* () {
    yield* getSession()
    const runId = yield* getRunId(context)
    const body = yield* decodeHitlRequest(request)
    const response = yield* firstHitlResponse(body)
    const encodedResponse = yield* encodeHitlResponse(response)
    const tailIndex = yield* currentWorkflowTailIndex(runId)

    yield* Effect.promise(() =>
      resumeHook(
        agentWorkflowHitlHookToken({ sessionId: body.sessionId, requestId: response.requestId }),
        encodedResponse
      )
    )

    return workflowResumeResponse(runId, getRun, {
      startIndex: tailIndex,
      tailIndex
    })
  }).pipe(
    Effect.withSpan('AgentWorkflowRunRoute.post'),
    Effect.catchTag('UnauthenticatedError', () =>
      Effect.succeed(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    ),
    Effect.catchTag('AgentWorkflowHitlRequestError', error =>
      reportError(error, {
        operation: 'agent.workflow.hitl_resume',
        status: 400
      }).pipe(Effect.andThen(Effect.succeed(Response.json({ error: error.message }, { status: 400 }))))
    ),
    Effect.catch(error =>
      reportError(new AgentWorkflowRunRouteError({ message: 'Workflow HITL resume failed', cause: error }), {
        operation: 'agent.workflow.hitl_resume',
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

export const GET = (request: Request, context: RouteContext) => Effect.runPromise(resumeProgram(request, context))
export const POST = (request: Request, context: RouteContext) =>
  Effect.runPromise(hitlResumeProgram(request, context))
export const DELETE = (_request: Request, context: RouteContext) =>
  Effect.runPromise(cancelProgram(context))
