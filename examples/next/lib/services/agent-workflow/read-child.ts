import { Clock, Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { ToolResult } from '@yolk-sdk/agent/protocol'
import { VercelWorkflows } from '@yolk-sdk/vercel-workflows/effect'
import { AgentWorkflowStore } from './live-layer'
import { childAdmissionWaitMs } from './policy'

export type WorkflowChildRead = {
  readonly done: boolean
  readonly workflowRunId: string | null
  readonly result: unknown
}

const failed = (callId: string, message: string) =>
  Schema.encodeEffect(ToolResult)(
    ToolResult.make({ toolCallId: callId, content: message, isError: true })
  )

/** Shared by Workflow short steps and the owned HTTP lookup after the parent has ended. */
export const readWorkflowChild = (
  input: {
    readonly parentRunId: string
    readonly userId: string
    readonly callId: string
  },
  attemptedRunId?: string
) =>
  Effect.gen(function* () {
    const store = yield* AgentWorkflowStore
    const registry = yield* store.read(input.parentRunId, input.userId)
    const child = registry.children.find(child => child.callId === input.callId)
    if (child !== undefined && child.result !== null)
      return { done: true, workflowRunId: child.workflowRunId, result: child.result }
    if (child === undefined || registry.stopped)
      return {
        done: true,
        workflowRunId: child?.workflowRunId ?? null,
        result: yield* failed(
          input.callId,
          child === undefined ? 'Child handle not found' : 'Child cancelled'
        )
      }
    if (child.workflowRunId === null) {
      const now = yield* Clock.currentTimeMillis
      if (child.launchUncertain === true || now - child.startedAtMs >= childAdmissionWaitMs) {
        // This ends this wait, not the child's lifecycle. A lost start response may still
        // self-admit later; do not commit a false terminal outcome or steal its reservation.
        return {
          done: true,
          workflowRunId: null,
          result: yield* failed(
            input.callId,
            'Child launch is unconfirmed. Check subagent_status later; no execution outcome is known.'
          )
        }
      }
    }
    const observedRunId = child.workflowRunId ?? attemptedRunId
    if (observedRunId === undefined) return { done: false, workflowRunId: null, result: null }
    const workflows = yield* VercelWorkflows
    const run = yield* workflows.getRun(observedRunId)
    const status = yield* run.status
    if (status === 'failed' || status === 'cancelled' || status === 'completed') {
      // Terminal persistence precedes platform completion; reread to avoid racing that commit.
      const latest = yield* store.read(input.parentRunId, input.userId)
      const result = latest.children.find(child => child.callId === input.callId)?.result
      return {
        done: true,
        workflowRunId: child.workflowRunId,
        result:
          result ??
          (yield* failed(
            input.callId,
            latest.stopped ? 'Child cancelled' : `Child workflow ${status} without a stored outcome`
          ))
      }
    }
    return { done: false, workflowRunId: child.workflowRunId, result: null }
  }).pipe(Effect.withSpan('AgentWorkflow.readChild'))
