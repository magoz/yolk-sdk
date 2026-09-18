import { Predicate } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  InputRequest,
  InputResponse,
  InputRequested,
  InputSubmitted,
  InputCancelled,
  ToolCall
} from '@yolk-sdk/agent/protocol'
import {
  applyAgentEvent,
  initialAgentClientState,
  isActiveToolRun,
  toolRunsFromHitlRequests
} from '../../src/client/index.ts'

const call = ToolCall.make({ id: 'call_word', name: 'word', params: {} })

const inputRequest = InputRequest.make({
  requestId: 'input:word:call_word',
  toolCallId: call.id,
  call,
  input: { kind: 'text-field' }
})

const submittedResponse = InputResponse.make({
  requestId: 'input:word:call_word',
  toolCallId: call.id,
  outcome: 'submitted',
  source: 'user',
  data: 'kind'
})

describe('input client state', () => {
  it('projects input requests into tool runs', () => {
    const runs = toolRunsFromHitlRequests([inputRequest])

    expect(runs).toHaveLength(1)

    expect(runs[0]).toEqual({ _tag: 'InputRequested', request: inputRequest })

    expect(runs.every(run => isActiveToolRun(run))).toBe(true)
  })

  it('tracks pending input through submitted completion', () => {
    const pending = applyAgentEvent(
      initialAgentClientState,
      InputRequested.make({ request: inputRequest })
    )

    const pendingRun = pending.toolRuns.find(run => Predicate.isTagged(run, 'InputRequested'))

    if (!Predicate.isTagged(pendingRun, 'InputRequested')) {
      throw new Error('Expected InputRequested tool run')
    }

    expect(isActiveToolRun(pendingRun)).toBe(true)

    const completed = applyAgentEvent(pending, InputSubmitted.make({ response: submittedResponse }))

    const submittedRun = completed.toolRuns.find(run => Predicate.isTagged(run, 'InputSubmitted'))

    if (!Predicate.isTagged(submittedRun, 'InputSubmitted')) {
      throw new Error('Expected InputSubmitted tool run')
    }

    expect(isActiveToolRun(submittedRun)).toBe(false)

    expect(submittedRun.request).toEqual(inputRequest)

    expect(submittedRun.response).toEqual(submittedResponse)
  })

  it('tracks cancelled input as settled with a preserved request', () => {
    const pending = applyAgentEvent(
      initialAgentClientState,
      InputRequested.make({ request: inputRequest })
    )

    const cancelled = InputResponse.make({
      requestId: 'input:word:call_word',
      toolCallId: call.id,
      outcome: 'cancelled',
      source: 'user',
      reason: 'not now'
    })

    const settled = applyAgentEvent(pending, InputCancelled.make({ response: cancelled }))

    const cancelledRun = settled.toolRuns.find(run => Predicate.isTagged(run, 'InputCancelled'))

    if (!Predicate.isTagged(cancelledRun, 'InputCancelled')) {
      throw new Error('Expected InputCancelled tool run')
    }

    expect(isActiveToolRun(cancelledRun)).toBe(false)

    expect(cancelledRun.request).toEqual(inputRequest)
  })

  it('settles replayed submissions without a witnessed request', () => {
    const settled = applyAgentEvent(
      initialAgentClientState,
      InputSubmitted.make({ response: submittedResponse })
    )

    const submittedRun = settled.toolRuns.find(run => Predicate.isTagged(run, 'InputSubmitted'))

    if (!Predicate.isTagged(submittedRun, 'InputSubmitted')) {
      throw new Error('Expected InputSubmitted tool run')
    }

    expect(isActiveToolRun(submittedRun)).toBe(false)

    expect(submittedRun.request).toBeUndefined()
  })
})
