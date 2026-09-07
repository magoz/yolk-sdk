import { Data, Effect } from 'effect'
import { VercelWorkflows } from '@yolk-sdk/vercel-workflows/effect'
import { AgentWorkflowStore } from './live-layer'

export class WorkflowStopIncomplete extends Data.TaggedError('WorkflowStopIncomplete')<{
  readonly message: string
  readonly runIds: ReadonlyArray<string>
}> {}

/** User Stop only. Never invoke from a parent finalizer or platform failure handler. */
export const stopAgentWorkflow = (runId: string, userId: string) =>
  Effect.gen(function* () {
    const store = yield* AgentWorkflowStore
    const workflows = yield* VercelWorkflows
    // Durable barrier first. Late reservations/admissions are now rejected, even if cancel fails.
    const registry = yield* store.change(runId, userId, { type: 'stop' })
    const runIds = [
      runId,
      ...registry.children.flatMap(child =>
        child.workflowRunId === null ? [] : [child.workflowRunId]
      )
    ]
    const outcomes = yield* Effect.forEach(
      runIds,
      id =>
        Effect.gen(function* () {
          const run = yield* workflows.getRun(id)
          const status = yield* run.status
          if (status !== 'completed' && status !== 'failed' && status !== 'cancelled')
            yield* run.cancel
        }).pipe(
          Effect.result,
          Effect.map(result => ({ id, result }))
        ),
      { concurrency: 4 }
    )
    const failures = outcomes
      .filter(outcome => outcome.result._tag === 'Failure')
      .map(outcome => outcome.id)
    if (failures.length > 0)
      return yield* Effect.fail(
        new WorkflowStopIncomplete({
          message: 'Stop recorded; cancellation sweep incomplete. Retry Stop.',
          runIds: failures
        })
      )
  }).pipe(Effect.withSpan('AgentWorkflow.stop'))
