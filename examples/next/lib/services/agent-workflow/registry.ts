import { Data, Equal, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { HitlRequest, HitlResponse } from '@yolk-sdk/agent/protocol'

import { maxWorkflowChildren } from './policy'

export class WorkflowRegistryError extends Data.TaggedError('WorkflowRegistryError')<{
  readonly message: string
}> {}

export class WorkflowChildRecord extends Schema.Class<WorkflowChildRecord>('WorkflowChildRecord')({
  callId: Schema.String,
  request: Schema.Unknown,
  subagentType: Schema.String,
  description: Schema.String,
  startedAtMs: Schema.Number,
  workflowRunId: Schema.NullOr(Schema.String),
  launchUncertain: Schema.optionalKey(Schema.Boolean),
  result: Schema.NullOr(Schema.Unknown)
}) {}

/** The answer the resume route recorded for a pause before it resumed the pause's hook. */
export class WorkflowHitlAnswer extends Schema.Class<WorkflowHitlAnswer>('WorkflowHitlAnswer')({
  response: HitlResponse,
  /** Stream tail before the first resume: every retry of this answer replays from here. */
  tailIndex: Schema.Number
}) {}

/**
 * The run's latest HITL pause: its own hook token, the requests it holds, and at most one
 * recorded answer. A later pause replaces it, so an answer to an earlier pause finds nothing.
 */
export class WorkflowHitlPause extends Schema.Class<WorkflowHitlPause>('WorkflowHitlPause')({
  hookToken: Schema.String,
  requests: Schema.Array(HitlRequest),
  answer: Schema.NullOr(WorkflowHitlAnswer),
  /** The workflow took an answer from this pause's hook: the pause has moved on. */
  delivered: Schema.Boolean
}) {}

export class WorkflowRegistry extends Schema.Class<WorkflowRegistry>('WorkflowRegistry')({
  stopped: Schema.Boolean,
  children: Schema.Array(WorkflowChildRecord),
  hitlPause: Schema.optionalKey(WorkflowHitlPause)
}) {}

export const emptyWorkflowRegistry = () => WorkflowRegistry.make({ stopped: false, children: [] })

/** Same request id, call id, and semantic type: the response answers this request. */
export const answersHitlRequest = (request: HitlRequest, response: HitlResponse) =>
  request.requestId === response.requestId &&
  request.toolCallId === response.toolCallId &&
  ((Predicate.isTagged(request, 'InputRequest') && Predicate.isTagged(response, 'InputResponse')) ||
    (Predicate.isTagged(request, 'InteractionRequest') &&
      Predicate.isTagged(response, 'InteractionResponse')) ||
    (Predicate.isTagged(request, 'QuestionRequest') &&
      Predicate.isTagged(response, 'QuestionResponse')) ||
    (Predicate.isTagged(request, 'ToolApprovalRequest') &&
      Predicate.isTagged(response, 'ToolApprovalResponse')))

/** The pause whose recorded answer is `response`; none when the pause refused it. */
export const recordedHitlPause = (state: WorkflowRegistry, response: HitlResponse) => {
  const pause = state.hitlPause

  return pause !== undefined &&
    pause.answer !== null &&
    Equal.equals(pause.answer.response, response)
    ? Option.some({ hookToken: pause.hookToken, answer: pause.answer, delivered: pause.delivered })
    : Option.none()
}

/** The workflow can still take an answer from this token's hook. */
export const isHitlPausePending = (state: WorkflowRegistry, hookToken: string) =>
  state.hitlPause?.hookToken === hookToken && !state.hitlPause.delivered

export type RegistryCommand =
  | { readonly type: 'reserve'; readonly child: WorkflowChildRecord }
  | { readonly type: 'admit'; readonly callId: string; readonly workflowRunId: string }
  | { readonly type: 'launch-uncertain'; readonly callId: string }
  | {
      readonly type: 'complete'
      readonly callId: string
      readonly workflowRunId: string
      readonly result: unknown
    }
  | { readonly type: 'stop' }
  | { readonly type: 'pause'; readonly pause: WorkflowHitlPause }
  | { readonly type: 'answer'; readonly answer: WorkflowHitlAnswer }
  | { readonly type: 'deliver'; readonly hookToken: string }

const transitionHitlPause = (
  pause: WorkflowHitlPause | undefined,
  command: Extract<RegistryCommand, { readonly type: 'pause' | 'answer' | 'deliver' }>
) => {
  // A redelivered tool step records its pause again: keep the answer already recorded for it.
  if (command.type === 'pause')
    return pause?.hookToken === command.pause.hookToken ? pause : command.pause

  if (pause === undefined) return pause

  if (command.type === 'deliver')
    return pause.hookToken === command.hookToken
      ? WorkflowHitlPause.make({ ...pause, delivered: true })
      : pause

  // One answer per pause, and only to a request the pause holds.
  return pause.answer === null &&
    !pause.delivered &&
    pause.requests.some(request => answersHitlRequest(request, command.answer.response))
    ? WorkflowHitlPause.make({ ...pause, answer: command.answer })
    : pause
}

/** Pure transition shared by the locked DB adapter and behavioral fake. */
export const transitionWorkflowRegistry = (
  state: WorkflowRegistry,
  command: RegistryCommand
): WorkflowRegistry => {
  if (command.type === 'stop') return WorkflowRegistry.make({ ...state, stopped: true })

  if (state.stopped) return state

  if (command.type === 'pause' || command.type === 'answer' || command.type === 'deliver') {
    const hitlPause = transitionHitlPause(state.hitlPause, command)

    return hitlPause === undefined ? state : WorkflowRegistry.make({ ...state, hitlPause })
  }

  if (command.type === 'reserve') {
    if (state.children.some(child => child.callId === command.child.callId)) return state

    if (state.children.length >= maxWorkflowChildren) return state

    return WorkflowRegistry.make({ ...state, children: [...state.children, command.child] })
  }

  return WorkflowRegistry.make({
    ...state,
    children: state.children.map(child => {
      if (child.callId !== command.callId) return child

      if (command.type === 'launch-uncertain') {
        return child.workflowRunId === null
          ? WorkflowChildRecord.make({ ...child, launchUncertain: true })
          : child
      }

      if (command.type === 'admit') {
        return child.workflowRunId === null
          ? WorkflowChildRecord.make({
              ...child,
              workflowRunId: command.workflowRunId,
              launchUncertain: false
            })
          : child
      }

      return child.workflowRunId === command.workflowRunId && child.result === null
        ? WorkflowChildRecord.make({ ...child, result: command.result })
        : child
    })
  })
}
