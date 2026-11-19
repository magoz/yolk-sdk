import { Data, Equal, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { HitlRequest, HitlResponse } from '@yolk-sdk/agent/protocol'

import { maxHitlAnsweredPauses, maxWorkflowChildren } from './policy'

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
 * The run's latest HITL pause: its id, its own hook token, the requests it holds, and at most one
 * recorded answer. A later pause replaces it; only its answer stays, in `hitlAnswered`.
 */
export class WorkflowHitlPause extends Schema.Class<WorkflowHitlPause>('WorkflowHitlPause')({
  /**
   * The `eventId` of the pause's `AgentAwaitingInput`: what the client sees, and names with its
   * answer. Request ids alone are ambiguous: a request pends again after an invalid answer, and
   * providers reuse tool call ids across turns.
   */
  pauseId: Schema.String,
  hookToken: Schema.String,
  requests: Schema.Array(HitlRequest),
  answer: Schema.NullOr(WorkflowHitlAnswer),
  /** The workflow took an answer from this pause's hook: the pause has moved on. */
  delivered: Schema.Boolean
}) {}

/** An answer the workflow took from its pause's hook. */
export class WorkflowHitlDelivered extends Schema.Class<WorkflowHitlDelivered>(
  'WorkflowHitlDelivered'
)({
  pauseId: Schema.String,
  answer: WorkflowHitlAnswer
}) {}

export class WorkflowRegistry extends Schema.Class<WorkflowRegistry>('WorkflowRegistry')({
  stopped: Schema.Boolean,
  children: Schema.Array(WorkflowChildRecord),
  hitlPause: Schema.optionalKey(WorkflowHitlPause),
  /** The last `maxHitlAnsweredPauses` delivered answers, oldest first. */
  hitlAnswered: Schema.optionalKey(Schema.Array(WorkflowHitlDelivered))
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

/**
 * The answer recorded for pause `pauseId` when it is identical to `response`: the current
 * pause's, or a delivered one of the last `maxHitlAnsweredPauses` pauses. None for a different
 * answer, or an unknown or evicted pause. `pendingHookToken` is the hook to resume with it;
 * undefined once the workflow took it (delivered).
 */
export const recordedHitlAnswer = (
  state: WorkflowRegistry,
  pauseId: string,
  response: HitlResponse
) => {
  const pause = state.hitlPause

  if (pause?.pauseId === pauseId)
    return pause.answer !== null && Equal.equals(pause.answer.response, response)
      ? Option.some({
          answer: pause.answer,
          pendingHookToken: pause.delivered ? undefined : pause.hookToken
        })
      : Option.none()

  return Option.fromNullishOr(
    (state.hitlAnswered ?? []).find(entry => entry.pauseId === pauseId)
  ).pipe(
    Option.filter(entry => Equal.equals(entry.answer.response, response)),
    Option.map(entry => ({ answer: entry.answer, pendingHookToken: undefined }))
  )
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
  | { readonly type: 'answer'; readonly pauseId: string; readonly answer: WorkflowHitlAnswer }
  | { readonly type: 'deliver'; readonly hookToken: string }

type HitlCommand = Extract<RegistryCommand, { readonly type: 'pause' | 'answer' | 'deliver' }>

/** Keeps a taken pause's answer, bounded, so an identical retry is reported as delivered. */
const archiveHitlAnswer = (state: WorkflowRegistry, pause: WorkflowHitlPause) => {
  const answered = state.hitlAnswered ?? []

  if (pause.answer === null || answered.some(entry => entry.pauseId === pause.pauseId))
    return answered

  return [
    ...answered,
    WorkflowHitlDelivered.make({ pauseId: pause.pauseId, answer: pause.answer })
  ].slice(-maxHitlAnsweredPauses)
}

const transitionHitl = (state: WorkflowRegistry, command: HitlCommand): WorkflowRegistry => {
  const pause = state.hitlPause

  if (command.type === 'pause') {
    // A redelivered tool step records its pause again: keep the answer already recorded for it.
    if (pause?.hookToken === command.pause.hookToken) return state

    if (pause === undefined) return WorkflowRegistry.make({ ...state, hitlPause: command.pause })

    // A new pause means the workflow took the previous pause's (only, recorded) answer.
    return WorkflowRegistry.make({
      ...state,
      hitlPause: command.pause,
      hitlAnswered: archiveHitlAnswer(state, pause)
    })
  }

  if (pause === undefined) return state

  if (command.type === 'deliver')
    return pause.hookToken === command.hookToken
      ? WorkflowRegistry.make({
          ...state,
          hitlPause: WorkflowHitlPause.make({ ...pause, delivered: true }),
          hitlAnswered: archiveHitlAnswer(state, pause)
        })
      : state

  // Only an answer naming this pause can take its slot: one answer, to a request it holds.
  return pause.pauseId === command.pauseId &&
    pause.answer === null &&
    !pause.delivered &&
    pause.requests.some(request => answersHitlRequest(request, command.answer.response))
    ? WorkflowRegistry.make({
        ...state,
        hitlPause: WorkflowHitlPause.make({ ...pause, answer: command.answer })
      })
    : state
}

/** Pure transition shared by the locked DB adapter and behavioral fake. */
export const transitionWorkflowRegistry = (
  state: WorkflowRegistry,
  command: RegistryCommand
): WorkflowRegistry => {
  if (command.type === 'stop') return WorkflowRegistry.make({ ...state, stopped: true })

  if (state.stopped) return state

  if (command.type === 'pause' || command.type === 'answer' || command.type === 'deliver')
    return transitionHitl(state, command)

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
