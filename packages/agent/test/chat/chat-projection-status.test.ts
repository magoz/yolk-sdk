import { Predicate } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentAwaitingInput,
  AgentEnd,
  AssistantAgentMessage,
  AssistantMessageEvent,
  AssistantTextPart,
  HostToolCallPart,
  LLMStreamStart,
  QuestionAnswered,
  QuestionPrompt,
  QuestionRequest,
  QuestionRequested,
  QuestionResponse,
  ToolApprovalDenied,
  ToolApprovalGranted,
  ToolApprovalRequest,
  ToolApprovalRequested,
  ToolApprovalResponse,
  ToolCall,
  ToolExecutionCompleted,
  ToolExecutionStarted,
  ToolResult,
  agentStatusFromEvents,
  agentStatusTreeFromEvents,
  zeroAgentUsage,
  type AgentEvent,
  type HitlRequest
} from '@yolk-sdk/agent/protocol'
import {
  AgentChatAction,
  applyAgentEventToChatProjection,
  initialAgentChatState,
  makeAgentChatEventProjectionState,
  reduceAgentChatState,
  stepAgentChatProjection,
  type AgentChatEventProjectionState,
  type AgentChatState
} from '@yolk-sdk/agent/chat'

// `stepAgentChatProjection` gives a host that folds status itself beside the chat projection the
// same answer as the `useAgentChat` reducer: each case runs the step, the plain projection and the
// reducer side by side, and the status folded from the steps' `statusEvent`s
// (`agentStatusFromEvents`) must equal the reducer's after every event.

type Track = {
  readonly step: AgentChatEventProjectionState
  readonly plain: AgentChatEventProjectionState
  readonly chat: AgentChatState
  /** Every event applied, as a host without the fence would fold them. */
  readonly events: ReadonlyArray<AgentEvent>
  readonly statusEvents: ReadonlyArray<AgentEvent>
  /** The last event's `statusEvent`. */
  readonly last: AgentEvent | undefined
}

const initialTrack: Track = {
  step: makeAgentChatEventProjectionState(),
  plain: makeAgentChatEventProjectionState(),
  chat: initialAgentChatState,
  events: [],
  statusEvents: [],
  last: undefined
}

const applyEvent = (track: Track, event: AgentEvent): Track => {
  const step = stepAgentChatProjection(track.step, event)

  return {
    step: step.projection,
    plain: applyAgentEventToChatProjection(track.plain, event),
    chat: reduceAgentChatState(track.chat, AgentChatAction.Event({ event })),
    events: [...track.events, event],
    statusEvents:
      step.statusEvent === undefined
        ? track.statusEvents
        : [...track.statusEvents, step.statusEvent],
    last: step.statusEvent
  }
}

/** Applies each event and checks the step against the projection and the reducer after it. */
const applyEvents = (track: Track, events: ReadonlyArray<AgentEvent>): Track =>
  events.reduce((current, event) => {
    const next = applyEvent(current, event)

    expect(next.step).toEqual(next.plain)
    expect(next.step.chatMessages).toEqual(next.chat.chatMessages)
    expect(agentStatusFromEvents(next.statusEvents)).toEqual(next.chat.status)

    expect(agentStatusTreeFromEvents(next.statusEvents)).toEqual({
      root: next.chat.status,
      subagents: next.chat.subagents
    })

    return next
  }, track)

const run = (events: ReadonlyArray<AgentEvent>) => applyEvents(initialTrack, events)

const ask = (...calls: ReadonlyArray<ToolCall>) =>
  AssistantAgentMessage.make({
    parts: [
      AssistantTextPart.make({ content: 'One moment' }),
      ...calls.map(call => HostToolCallPart.make({ call }))
    ]
  })

const pause = (requests: readonly [HitlRequest, ...Array<HitlRequest>], eventId?: string) =>
  AgentAwaitingInput.make({ eventId, requests, messages: [], turns: 1, usage: zeroAgentUsage })

const end = (eventId: string) =>
  AgentEnd.make({ eventId, messages: [], turns: 1, usage: zeroAgentUsage })

const deploy = ToolCall.make({ id: 'call_0', name: 'deploy', params: { env: 'prod' } })

const deployRequest = ToolApprovalRequest.make({
  requestId: 'approval:call_0',
  toolCallId: deploy.id,
  call: deploy
})

const decision = (value: 'approved' | 'denied') =>
  ToolApprovalResponse.make({
    requestId: deployRequest.requestId,
    toolCallId: deploy.id,
    decision: value,
    source: 'user'
  })

const unit = ToolCall.make({ id: 'call_1', name: 'question', params: { topic: 'unit' } })

const unitRequest = QuestionRequest.make({
  requestId: 'question:call_1',
  toolCallId: unit.id,
  call: unit,
  questions: [QuestionPrompt.make({ id: 'unit', prompt: 'Celsius or Fahrenheit?' })]
})

/** Turn 1 asks to deploy; the run pauses, the person approves, the call completes, the run ends. */
const deployed: ReadonlyArray<AgentEvent> = [
  LLMStreamStart.make({ eventId: 'start-1', turn: 1 }),
  AssistantMessageEvent.make({ eventId: 'message-1', message: ask(deploy) }),
  ToolApprovalRequested.make({ eventId: 'request', call: deploy, request: deployRequest }),
  pause([deployRequest], 'pause'),
  ToolApprovalGranted.make({
    eventId: 'granted',
    toolCallId: deploy.id,
    response: decision('approved')
  }),
  ToolExecutionStarted.make({ eventId: 'started', call: deploy }),
  ToolExecutionCompleted.make({
    eventId: 'completed',
    call: deploy,
    result: ToolResult.make({ toolCallId: deploy.id, content: 'ok' })
  })
]

const nextTurn: ReadonlyArray<AgentEvent> = [
  LLMStreamStart.make({ eventId: 'start-2', turn: 2 }),
  AssistantMessageEvent.make({
    eventId: 'message-2',
    message: AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'Done' })] })
  })
]

describe('stepAgentChatProjection', () => {
  it.each([
    { position: 'in its turn', after: [] },
    { position: 'after the next turn started', after: nextTurn }
  ])('skips a replayed pause whose every call is past its request ($position)', ({ after }) => {
    const settled = run([...deployed, ...after, end('end')])

    expect(settled.chat.status).toMatchObject({ _tag: 'Done' })

    const replayed = applyEvents(settled, [pause([deployRequest])])

    expect(replayed.last).toBeUndefined()
    expect(replayed.step.chatMessages).toEqual(settled.step.chatMessages)
    expect(agentStatusFromEvents(replayed.statusEvents)).toMatchObject({ _tag: 'Done' })
    // Folding every event, the replay included, blocks the run with no card to answer.
    expect(agentStatusFromEvents(replayed.events)).toMatchObject({ _tag: 'Blocked' })
  })

  it('blocks a mixed pause only on its pending requests', () => {
    const answered = run([
      LLMStreamStart.make({ eventId: 'start-1', turn: 1 }),
      AssistantMessageEvent.make({ eventId: 'message-1', message: ask(deploy, unit) }),
      ToolApprovalRequested.make({ eventId: 'request', call: deploy, request: deployRequest }),
      QuestionRequested.make({ eventId: 'question', request: unitRequest }),
      pause([deployRequest, unitRequest], 'pause'),
      ToolApprovalDenied.make({
        eventId: 'denied',
        toolCallId: deploy.id,
        reason: 'Not now',
        response: decision('denied')
      })
    ])

    expect(answered.chat.status).toMatchObject({ _tag: 'Blocked', kind: 'permission' })

    const replayed = applyEvents(answered, [pause([deployRequest, unitRequest])])

    expect(replayed.last).toMatchObject({ _tag: 'AgentAwaitingInput', requests: [unitRequest] })

    expect(agentStatusFromEvents(replayed.statusEvents)).toMatchObject({
      _tag: 'Blocked',
      kind: 'question',
      requests: [unitRequest]
    })
  })

  it('passes a pause whose requests are all pending through unchanged', () => {
    const asked = run([
      LLMStreamStart.make({ eventId: 'start-1', turn: 1 }),
      AssistantMessageEvent.make({ eventId: 'message-1', message: ask(deploy, unit) }),
      ToolApprovalRequested.make({ eventId: 'request', call: deploy, request: deployRequest }),
      QuestionRequested.make({ eventId: 'question', request: unitRequest })
    ])

    const paused = pause([deployRequest, unitRequest], 'pause')
    const blocked = applyEvents(asked, [paused])

    expect(blocked.last).toBe(paused)
    expect(blocked.chat.status).toMatchObject({ _tag: 'Blocked', requests: paused.requests })
  })

  it.each([
    { start: 'after a model turn start', before: [LLMStreamStart.make({ turn: 1 })] },
    { start: 'with no start seen', before: [] }
  ])('blocks on a pause whose call has no part yet ($start)', ({ before }) => {
    const paused = pause([deployRequest])
    const blocked = run([...before, paused])

    expect(blocked.last).toBe(paused)
    expect(blocked.chat.status).toMatchObject({ _tag: 'Blocked', kind: 'permission' })
    expect(blocked.step.chatMessages.flatMap(message => message.parts)).toMatchObject([
      { _tag: 'ToolCall', state: { _tag: 'ApprovalRequested' } }
    ])
  })

  it("blocks on a later turn's call reusing a settled call's id", () => {
    const later = ToolCall.make({ id: deploy.id, name: 'deploy', params: { env: 'staging' } })

    const laterRequest = ToolApprovalRequest.make({
      requestId: deployRequest.requestId,
      toolCallId: later.id,
      call: later
    })

    const settled = run([...deployed, ...nextTurn])

    const paused = pause([laterRequest])

    const asked = applyEvents(settled, [
      LLMStreamStart.make({ eventId: 'start-3', turn: 3 }),
      AssistantMessageEvent.make({ eventId: 'message-3', message: ask(later) }),
      paused
    ])

    expect(asked.last).toBe(paused)
    expect(asked.chat.status).toMatchObject({ _tag: 'Blocked', requests: [laterRequest] })
  })

  it.each([
    { replay: 'pause', event: pause([deployRequest]), folded: false },
    {
      replay: 'request event',
      event: ToolApprovalRequested.make({ call: deploy, request: deployRequest }),
      // Status-neutral: folded, it leaves the status as it is.
      folded: true
    },
    {
      replay: 'tool batch start',
      event: ToolExecutionStarted.make({ call: deploy }),
      folded: false
    },
    {
      replay: 'tool batch completion',
      event: ToolExecutionCompleted.make({
        call: deploy,
        result: ToolResult.make({ toolCallId: deploy.id, content: 'ok' })
      }),
      // A settled call: folded, it leaves the blocked status as it is.
      folded: true
    }
  ])(
    "keeps blocking on a later turn's call when the earlier call's $replay replays",
    ({ event, folded }) => {
      const later = ToolCall.make({ id: deploy.id, name: 'deploy', params: { env: 'staging' } })

      const laterRequest = ToolApprovalRequest.make({
        requestId: deployRequest.requestId,
        toolCallId: later.id,
        call: later
      })

      const asked = applyEvents(run([...deployed, ...nextTurn]), [
        LLMStreamStart.make({ eventId: 'start-3', turn: 3 }),
        AssistantMessageEvent.make({ eventId: 'message-3', message: ask(later) }),
        ToolApprovalRequested.make({ eventId: 'request-3', call: later, request: laterRequest }),
        pause([laterRequest], 'pause-3')
      ])

      expect(asked.chat.status).toMatchObject({ _tag: 'Blocked', requests: [laterRequest] })

      const replayed = applyEvents(asked, [event])

      expect(replayed.last).toBe(folded ? event : undefined)
      expect(replayed.step.chatMessages).toEqual(asked.step.chatMessages)
      expect(replayed.chat.status).toEqual(asked.chat.status)
      expect(agentStatusFromEvents(replayed.statusEvents)).toEqual(asked.chat.status)
    }
  )

  it("skips a pause of a superseded execution's turn", () => {
    const tagged = (executionId: string) => ({ executionId, streamId: 'run-1' })

    const retried = run([
      LLMStreamStart.make({ ...tagged('a'), eventId: 'a:start', turn: 1 }),
      AssistantMessageEvent.make({ ...tagged('a'), eventId: 'a:message', message: ask(deploy) }),
      LLMStreamStart.make({ ...tagged('b'), eventId: 'b:start', turn: 1 })
    ])

    expect(retried.chat.status).toMatchObject({ _tag: 'Working' })

    const late = applyEvents(retried, [
      AgentAwaitingInput.make({
        ...tagged('a'),
        eventId: 'a:pause',
        requests: [deployRequest],
        messages: [],
        turns: 1,
        usage: zeroAgentUsage
      })
    ])

    expect(late.last).toBeUndefined()
    expect(late.chat.status).toEqual(retried.chat.status)
    expect(agentStatusFromEvents(late.events)).toMatchObject({ _tag: 'Blocked' })
  })

  it("skips a stale execution's start and pause", () => {
    const tagged = (executionId: string) => ({ executionId, streamId: 'run-1' })

    const second = run([
      LLMStreamStart.make({ ...tagged('a'), eventId: 'a:start', turn: 1 }),
      LLMStreamStart.make({ ...tagged('c'), eventId: 'c:start', turn: 2 })
    ])

    const stale = applyEvents(second, [
      LLMStreamStart.make({ ...tagged('d'), eventId: 'd:start', turn: 1 }),
      AgentAwaitingInput.make({
        ...tagged('d'),
        eventId: 'd:pause',
        requests: [deployRequest],
        messages: [],
        turns: 1,
        usage: zeroAgentUsage
      })
    ])

    expect(stale.statusEvents).toEqual(second.statusEvents)
    expect(stale.chat.status).toEqual(second.chat.status)
  })

  it('skips an event seen before and a replayed start of a finished call', () => {
    const settled = run([...deployed, end('end')])

    const replayed = applyEvents(settled, [
      pause([deployRequest], 'pause'),
      ToolExecutionStarted.make({ call: deploy })
    ])

    expect(replayed.statusEvents).toEqual(settled.statusEvents)
    expect(replayed.chat.status).toMatchObject({ _tag: 'Done' })
  })

  it('keeps the answer of a question replayed with its pause', () => {
    // A question answered by the server, then its request and pause replayed without event ids.
    const answered = run([
      LLMStreamStart.make({ eventId: 'start-1', turn: 1 }),
      AssistantMessageEvent.make({ eventId: 'message-1', message: ask(unit) }),
      QuestionRequested.make({ eventId: 'question', request: unitRequest }),
      pause([unitRequest], 'pause'),
      QuestionAnswered.make({
        eventId: 'answered',
        response: QuestionResponse.make({
          requestId: unitRequest.requestId,
          toolCallId: unit.id,
          outcome: 'answered',
          source: 'user',
          answers: []
        })
      })
    ])

    const replayed = applyEvents(answered, [
      QuestionRequested.make({ request: unitRequest }),
      pause([unitRequest])
    ])

    expect(replayed.last).toBeUndefined()
    expect(replayed.chat.status).toEqual(answered.chat.status)

    expect(
      replayed.step.chatMessages.flatMap(message =>
        message.parts.flatMap(part => (Predicate.isTagged(part, 'ToolCall') ? [part.state] : []))
      )
    ).toMatchObject([{ _tag: 'QuestionAnswered' }])
  })
})
