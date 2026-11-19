import { Data, Effect, Option, Predicate, Schedule } from 'effect'
import * as Schema from 'effect/Schema'
import { HookNotFoundError } from 'workflow/errors'
import { HitlResponse } from '@yolk-sdk/agent/protocol'
import { VercelWorkflows } from '@yolk-sdk/vercel-workflows/effect'
import { AgentWorkflowStore, type UserId, type WorkflowRunId } from './live-layer'
import { isHitlPausePending, recordedHitlAnswer, WorkflowHitlAnswer } from './registry'

/** No pause took this answer: it answers no pending request, or the pause has another. */
export class WorkflowHitlAnswerRefused extends Data.TaggedError('WorkflowHitlAnswerRefused')<{
  readonly message: string
}> {}

/** The answer is recorded but its pause's hook did not open in time; retrying is safe. */
export class WorkflowHitlHookPending extends Data.TaggedError('WorkflowHitlHookPending')<{
  readonly message: string
}> {}

// Immediate, then +250ms, +500ms, +1s, +2s: covers a client that answers before the workflow
// replays and opens the pause's hook.
const hookPendingRetry = Schedule.max([Schedule.exponential('250 millis', 2.0), Schedule.recurs(4)])

/**
 * Records `response` durably as the answer of the stored pause holding its request, then resumes
 * that pause's hook with the recorded answer. An identical retry reuses the record, and one of an
 * answer the workflow already took (from this or an earlier pause) is reported as delivered
 * without resuming. A different answer to the current pause, or one to a request it does not
 * hold, is refused before any hook sees it. Returns the recorded answer: `resumeHook` success
 * does not mean the answer was used, so callers report the record, not the resume.
 */
export const resumeWorkflowHitlAnswer = (input: {
  readonly runId: WorkflowRunId
  readonly userId: UserId
  readonly response: HitlResponse
  readonly tailIndex: number
}) =>
  Effect.gen(function* () {
    const store = yield* AgentWorkflowStore
    const workflows = yield* VercelWorkflows

    const state = yield* store.change(input.runId, input.userId, {
      type: 'answer',
      answer: WorkflowHitlAnswer.make({ response: input.response, tailIndex: input.tailIndex })
    })

    const recorded = recordedHitlAnswer(state, input.response)

    if (Option.isNone(recorded))
      return yield* Effect.fail(
        new WorkflowHitlAnswerRefused({ message: 'No pending request accepts this response' })
      )

    const { hookToken, answer, delivered } = recorded.value

    // The workflow already took this answer (an earlier attempt of this resume): report it.
    if (delivered) return answer

    const payload = yield* Schema.encodeEffect(HitlResponse)(answer.response)

    yield* workflows.resumeHook(hookToken, payload).pipe(
      Effect.catchIf(
        error => HookNotFoundError.is(error.cause),
        () =>
          store.read(input.runId, input.userId).pipe(
            Effect.flatMap(current =>
              // Still pending: the hook does not exist yet. Moved on: the answer was delivered.
              isHitlPausePending(current, hookToken)
                ? Effect.fail(
                    new WorkflowHitlHookPending({
                      message: 'The paused run is not ready for this answer yet. Retry.'
                    })
                  )
                : Effect.void
            )
          )
      ),
      Effect.retry({
        while: error => Predicate.isTagged(error, 'WorkflowHitlHookPending'),
        schedule: hookPendingRetry
      })
    )

    return answer
  }).pipe(Effect.withSpan('AgentWorkflow.resumeHitlAnswer'))
