import { Effect, Layer } from 'effect'
import { VercelWorkflows } from '@yolk-sdk/vercel-workflows/effect'
import { AppLayer } from '@/lib/layers'
import { getSession } from '@/lib/services/auth/get-session'
import { AgentWorkflowStore } from '@/lib/services/agent-workflow/live-layer'
import { readWorkflowChild } from '@/lib/services/agent-workflow/read-child'
import { reportError } from '@/lib/services/telemetry/report-error'

export const dynamic = 'force-dynamic'

// Original parent/call identity is durable, including after the parent has terminated.
export const GET = (
  _request: Request,
  context: { readonly params: Promise<{ readonly runId: string; readonly toolCallId: string }> }
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* getSession()
      const params = yield* Effect.promise(() => context.params)
      const result = yield* readWorkflowChild({
        parentRunId: params.runId,
        callId: params.toolCallId,
        userId: session.user.id
      })
      return Response.json(result)
    }).pipe(
      Effect.withSpan('AgentWorkflowChildRoute.get'),
      Effect.catchTag('UnauthenticatedError', () =>
        Effect.succeed(Response.json({ error: 'Unauthorized' }, { status: 401 }))
      ),
      Effect.catchTag('WorkflowRunForbidden', () =>
        Effect.succeed(Response.json({ error: 'Not found' }, { status: 404 }))
      ),
      Effect.catch(error =>
        reportError(error, { operation: 'agent.workflow.child.read' }).pipe(
          Effect.as(Response.json({ error: 'Child lookup failed' }, { status: 500 }))
        )
      ),
      Effect.provide(Layer.mergeAll(AppLayer, AgentWorkflowStore.layer, VercelWorkflows.layer))
    )
  )
