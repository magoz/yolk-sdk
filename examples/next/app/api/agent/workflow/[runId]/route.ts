import { Data, Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { HitlResponse } from '@yolk-sdk/agent/protocol'
import { getRun, resumeHook } from 'workflow/api'
import { AppLayer } from '@/lib/layers'
import { agentWorkflowHitlHookToken } from '@/lib/agents/workflow-runtime/run-agent-workflow'
import { getSession } from '@/lib/services/auth/get-session'
import { reportError } from '@/lib/services/telemetry/report-error'
import {
  workflowCancelResponse,
  workflowResumeResponse,
  workflowResumeStartIndexFromUrl,
  workflowResumeStartIndexAfterTail
} from './route-model'
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

class AgentWorkflowRunRequestError extends Data.TaggedError('AgentWorkflowRunRequestError')<{
  message: string
  cause?: unknown
}> {}

class AgentWorkflowHitlResumeRequest extends Schema.Class<AgentWorkflowHitlResumeRequest>(
  'AgentWorkflowHitlResumeRequest'
)({
  hitlResponses: Schema.Tuple([HitlResponse])
}) {}

const invalidHitlRequest = (message: string, cause?: unknown) =>
  new AgentWorkflowHitlRequestError({ message, cause })

const getRunId = (context: RouteContext) =>
  Effect.promise(() => context.params).pipe(Effect.map(params => params.runId))

const readRequestJson = (request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: error => invalidHitlRequest('Invalid request body', error)
  })

const hitlResponse = (request: AgentWorkflowHitlResumeRequest) =>
  Effect.succeed(request.hitlResponses[0])

const decodeHitlRequest = (request: Request) =>
  readRequestJson(request).pipe(
    Effect.flatMap(body => Schema.decodeUnknownEffect(AgentWorkflowHitlResumeRequest)(body)),
    Effect.mapError(error => invalidHitlRequest('Invalid HITL request body', error))
  )

const encodeHitlResponse = (response: HitlResponse) =>
  Schema.encodeUnknownEffect(HitlResponse)(response).pipe(
    Effect.mapError(error => invalidHitlRequest('Invalid HITL response', error))
  )

const parseStartIndex = (request: Request) => {
  const result = workflowResumeStartIndexFromUrl(request.url)

  if (result._tag === 'ValidStartIndex') {
    return Effect.succeed(result.startIndex)
  }

  return Effect.fail(
    new AgentWorkflowRunRequestError({
      message: 'Invalid workflow stream startIndex',
      cause: result.raw
    })
  )
}

const currentWorkflowTailIndex = (runId: string) =>
  Effect.tryPromise({
    try: () => workflowReadableTailIndex(getRun(runId).getReadable<Uint8Array>({ startIndex: -1 })),
    catch: error =>
      new AgentWorkflowRunRouteError({ message: 'Workflow stream cursor failed', cause: error })
  })

const requireWorkflowTailIndex = (tailIndex: number | undefined) =>
  tailIndex === undefined
    ? Effect.fail(new AgentWorkflowRunRouteError({ message: 'Workflow stream cursor missing' }))
    : Effect.succeed(tailIndex)

const resumeProgram = (request: Request, context: RouteContext) =>
  Effect.gen(function* () {
    yield* getSession()
    const runId = yield* getRunId(context)
    const startIndex = yield* parseStartIndex(request)
    return workflowResumeResponse(runId, getRun, { startIndex })
  }).pipe(
    Effect.withSpan('AgentWorkflowRunRoute.get'),
    Effect.catchTag('UnauthenticatedError', () =>
      Effect.succeed(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    ),
    Effect.catchTag('AgentWorkflowRunRequestError', error =>
      reportError(error, {
        operation: 'agent.workflow.resume',
        status: 400
      }).pipe(
        Effect.andThen(Effect.succeed(Response.json({ error: error.message }, { status: 400 })))
      )
    ),
    Effect.catch(error =>
      reportError(
        new AgentWorkflowRunRouteError({ message: 'Workflow resume failed', cause: error }),
        {
          operation: 'agent.workflow.resume',
          status: 500
        }
      ).pipe(
        Effect.andThen(Effect.succeed(Response.json({ error: 'Internal error' }, { status: 500 })))
      )
    ),
    Effect.provide(AppLayer)
  )

const hitlResumeProgram = (request: Request, context: RouteContext) =>
  Effect.gen(function* () {
    yield* getSession()
    const runId = yield* getRunId(context)
    const body = yield* decodeHitlRequest(request)
    const response = yield* hitlResponse(body)
    const encodedResponse = yield* encodeHitlResponse(response)
    const tailIndex = yield* currentWorkflowTailIndex(runId).pipe(
      Effect.flatMap(requireWorkflowTailIndex)
    )

    yield* Effect.promise(() => resumeHook(agentWorkflowHitlHookToken({ runId }), encodedResponse))

    return workflowResumeResponse(runId, getRun, {
      startIndex: workflowResumeStartIndexAfterTail(tailIndex),
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
      }).pipe(
        Effect.andThen(Effect.succeed(Response.json({ error: error.message }, { status: 400 })))
      )
    ),
    Effect.catch(error =>
      reportError(
        new AgentWorkflowRunRouteError({ message: 'Workflow HITL resume failed', cause: error }),
        {
          operation: 'agent.workflow.hitl_resume',
          status: 500
        }
      ).pipe(
        Effect.andThen(Effect.succeed(Response.json({ error: 'Internal error' }, { status: 500 })))
      )
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
      reportError(
        new AgentWorkflowRunRouteError({ message: 'Workflow cancel failed', cause: error }),
        {
          operation: 'agent.workflow.cancel',
          status: 500
        }
      ).pipe(
        Effect.andThen(Effect.succeed(Response.json({ error: 'Internal error' }, { status: 500 })))
      )
    ),
    Effect.provide(AppLayer)
  )

export const GET = (request: Request, context: RouteContext) =>
  Effect.runPromise(resumeProgram(request, context))
export const POST = (request: Request, context: RouteContext) =>
  Effect.runPromise(hitlResumeProgram(request, context))
export const DELETE = (_request: Request, context: RouteContext) =>
  Effect.runPromise(cancelProgram(context))
