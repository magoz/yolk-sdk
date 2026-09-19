import { Predicate } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  InteractionRequest,
  InteractionRequested,
  InteractionResponse,
  InteractionSubmitted,
  ToolCall,
  ToolExecutionCompleted,
  ToolExecutionStarted,
  ToolResult,
  UserMessage,
  interactionRequestId
} from '@yolk-sdk/agent/protocol'
import {
  applyAgentEvent,
  initialAgentClientState,
  isActiveToolRun,
  markAgentError,
  markAgentAborted,
  submitAgentUserMessage,
  toolRunsFromHitlRequests
} from '../../src/client/state.ts'

const call = ToolCall.make({ id: 'call_doc', name: 'document', params: {} })

const request: InteractionRequest = InteractionRequest.make({
  requestId: interactionRequestId(call),
  toolCallId: call.id,
  call,
  interaction: {
    kind: 'document-editor',
    actions: [{ id: 'publish', label: 'Publish' }]
  }
})

const submitted = InteractionResponse.make({
  requestId: request.requestId,
  toolCallId: call.id,
  outcome: 'submitted',
  source: 'user',
  actionId: 'publish',
  data: { title: 'Edited title', body: 'Edited body' }
})

describe('interaction client projection', () => {
  it('restores pending interactions from HITL requests', () => {
    const runs = toolRunsFromHitlRequests([request])

    expect(runs).toHaveLength(1)

    expect(runs[0]?._tag).toBe('InteractionRequested')
  })

  it('keeps acceptance distinct from executing and completion', () => {
    const requested = applyAgentEvent(
      initialAgentClientState,
      InteractionRequested.make({ request })
    )

    const requestedRun = requested.toolRuns.find(run =>
      Predicate.isTagged(run, 'InteractionRequested')
    )

    expect(requestedRun).toBeDefined()

    expect(requestedRun !== undefined && isActiveToolRun(requestedRun)).toBe(true)

    const accepted = applyAgentEvent(requested, InteractionSubmitted.make({ response: submitted }))

    const acceptedRun = accepted.toolRuns.find(run =>
      Predicate.isTagged(run, 'InteractionSubmitted')
    )

    expect(acceptedRun).toBeDefined()

    expect(acceptedRun !== undefined && isActiveToolRun(acceptedRun)).toBe(true)
    // Acceptance is not completion: no Completed run is synthesized.
    expect(accepted.toolRuns.some(run => Predicate.isTagged(run, 'Completed'))).toBe(false)

    const executing = applyAgentEvent(accepted, ToolExecutionStarted.make({ call, createdAtMs: 1 }))

    const executingRun = executing.toolRuns.find(run => Predicate.isTagged(run, 'Executing'))

    expect(executingRun).toBeDefined()

    expect(executingRun !== undefined && isActiveToolRun(executingRun)).toBe(true)
  })

  it('retains accepted interactions through disconnect, abort and restart until a result', () => {
    const accepted = applyAgentEvent(
      applyAgentEvent(initialAgentClientState, InteractionRequested.make({ request })),
      InteractionSubmitted.make({ response: submitted })
    )

    const executing = applyAgentEvent(accepted, ToolExecutionStarted.make({ call }))

    for (const prior of [accepted, executing]) {
      for (const interrupted of [markAgentError(prior, 'disconnected'), markAgentAborted(prior)]) {
        const restarted = submitAgentUserMessage(
          interrupted,
          UserMessage.make({ content: 'Continue' })
        )

        for (const state of [interrupted, restarted]) {
          expect(state.toolRuns).toEqual(prior.toolRuns)
          expect(state.toolRuns.some(isActiveToolRun)).toBe(true)

          const settled = applyAgentEvent(
            state,
            ToolExecutionCompleted.make({
              call,
              result: ToolResult.make({ toolCallId: call.id, content: 'Recovered result' })
            })
          )

          expect(settled.toolRuns).toMatchObject([{ _tag: 'Completed' }])
          expect(settled.toolRuns.some(isActiveToolRun)).toBe(false)
        }
      }
    }
  })

  it('preserves failed and unknown outcomes on completion', () => {
    const requested = applyAgentEvent(
      initialAgentClientState,
      InteractionRequested.make({ request })
    )

    const accepted = applyAgentEvent(requested, InteractionSubmitted.make({ response: submitted }))

    const unknownResult = ToolResult.make({
      toolCallId: call.id,
      content: 'Fire request timed out. Outcome unknown: the action may have taken effect.',
      isError: true,
      structuredContent: {
        type: 'interaction_outcome',
        outcome: 'unknown',
        slot: request.requestId,
        actionId: 'publish'
      }
    })

    const completed = applyAgentEvent(
      accepted,
      ToolExecutionCompleted.make({ call, result: unknownResult, createdAtMs: 2 })
    )

    const completedRun = completed.toolRuns.find(run => Predicate.isTagged(run, 'Completed'))

    expect(Predicate.isTagged(completedRun, 'Completed')).toBe(true)

    if (Predicate.isTagged(completedRun, 'Completed')) {
      expect(completedRun.result.isError).toBe(true)

      expect(completedRun.result.structuredContent).toMatchObject({ outcome: 'unknown' })
    }
  })
})
