import { Data, Effect, Option, Predicate, Schedule } from 'effect'
import * as Schema from 'effect/Schema'
import { HookNotFoundError } from 'workflow/errors'
import { HitlResponse } from '@yolk-sdk/agent/protocol'
import { VercelWorkflows } from '@yolk-sdk/vercel-workflows/effect'
import { AgentWorkflowStore, type UserId, type WorkflowRunId } from './live-layer'
import { isHitlPausePending, recordedHitlAnswer, WorkflowHitlAnswer } from './registry'

/** The named pause does not take this answer; `message` says why. */
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
 * Records `response` durably as the answer of pause `pauseId` (the `eventId` of the
 * `AgentAwaitingInput` the client answered), then resumes that pause's hook with it. Matching is
 * strictly by the named pause:
 * - the current pause: the first answer to a request it holds is recorded; an identical retry
 *   reuses the record; anything else is refused while that answer occupies the pause;
 * - a delivered pause among the last `maxHitlAnsweredPauses`: an identical answer is reported as
 *   delivered (never resumed again); a different one is refused;
 * - no pause named, or an unknown or evicted one: refused, never recorded for the current pause.
 * Returns the recorded answer: `resumeHook` success does not mean the answer was used, so callers
 * report the record, not the resume.
 */
export const resumeWorkflowHitlAnswer = (input: {
  readonly runId: WorkflowRunId
  readonly userId: UserId
  readonly pauseId: string | undefined
  readonly response: HitlResponse
  readonly tailIndex: number
}) =>
  Effect.gen(function* () {
    const store = yield* AgentWorkflowStore
    const workflows = yield* VercelWorkflows
    const pauseId = input.pauseId

    // A request id alone cannot say which pause it answers (re-pends, reused tool call ids).
    if (pauseId === undefined)
      return yield* Effect.fail(
        new WorkflowHitlAnswerRefused({
          message: 'Name the pause this answers: the eventId of its AgentAwaitingInput (?pause=)'
        })
      )

    const state = yield* store.change(input.runId, input.userId, {
      type: 'answer',
      pauseId,
      answer: WorkflowHitlAnswer.make({ response: input.response, tailIndex: input.tailIndex })
    })

    const recorded = recordedHitlAnswer(state, pauseId, input.response)

    if (Option.isNone(recorded))
      return yield* Effect.fail(
        new WorkflowHitlAnswerRefused({ message: 'This pause does not accept this response' })
      )

    const { answer, pendingHookToken: hookToken } = recorded.value

    // The workflow already took this answer (an earlier attempt of this resume): report it.
    if (hookToken === undefined) return answer

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
