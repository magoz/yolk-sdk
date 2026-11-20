import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  AssistantTextPart,
  BackgroundToolAccepted,
  HostToolCallPart,
  InteractionResponse,
  ToolApprovalRequest,
  ToolCall,
  ToolResult,
  ToolResultMessage,
  UserMessage,
  makeBackgroundToolAcceptedResult,
  toolResultMessageFromResult,
  type AgentMessage
} from '@yolk-sdk/agent/protocol'
import { Predicate } from 'effect'
import { AgentToolRun, toolRunsFromHitlRequests } from '../../src/client/state.ts'
import { buildAgentChatMessages } from '../../src/react/chat-messages.ts'

// Providers reuse call ids across turns (`call_0` in every turn), so `toolRuns` can hold one run per
// turn for an id (`reduceAgentEvents`), and snapshot hosts pass runs of several turns: pending
// requests (`toolRunsFromHitlRequests`) and accepted interaction receipts. Each card shows its own
// run (#356).

const review = ToolCall.make({
  id: 'call_0',
  name: 'review_document',
  params: { documentId: 'doc-1' }
})

const send = ToolCall.make({ id: 'call_0', name: 'send', params: { to: 'ana' } })

const turn = (content: string, call: ToolCall) =>
  AssistantAgentMessage.make({
    parts: [AssistantTextPart.make({ content }), HostToolCallPart.make({ call })]
  })

const reviewed = ToolResultMessage.make({ toolCallId: 'call_0', content: 'Reviewed' })

/** Turn 1 reviewed the document (an interaction), turn 2 asks to send it (an approval). */
const transcript: ReadonlyArray<AgentMessage> = [
  UserMessage.make({ content: 'Review it, then send it' }),
  turn('Reviewing', review),
  reviewed,
  turn('Sending', send)
]

const approval = ToolApprovalRequest.make({
  requestId: 'approval:call_0',
  toolCallId: 'call_0',
  call: send
})

const pending = toolRunsFromHitlRequests([approval])

/** An accepted interaction receipt's run (o-o): only the response, no request or call. */
const acceptedInteraction = AgentToolRun.InteractionSubmitted({
  response: InteractionResponse.make({
    requestId: 'interaction:call_0',
    toolCallId: 'call_0',
    outcome: 'submitted',
    source: 'user',
    actionId: 'approve'
  })
})

const build = (messages: ReadonlyArray<AgentMessage>, toolRuns: ReadonlyArray<AgentToolRun>) =>
  buildAgentChatMessages({
    messages,
    userDraft: '',
    assistantDraft: '',
    reasoningDraft: '',
    toolRuns,
    error: null
  })

/** Each card as `name:state`. */
const cards = (messages: ReadonlyArray<AgentMessage>, toolRuns: ReadonlyArray<AgentToolRun>) =>
  build(messages, toolRuns).flatMap(message =>
    message.parts.flatMap(part =>
      Predicate.isTagged(part, 'ToolCall') ? [`${part.call.name}:${part.state._tag}`] : []
    )
  )

describe('buildAgentChatMessages with a call id reused across turns (#356)', () => {
  it('gives each card its own run: an accepted interaction and a pending approval, in any order', () => {
    for (const toolRuns of [
      [...pending, acceptedInteraction],
      [acceptedInteraction, ...pending]
    ]) {
      expect(cards(transcript, toolRuns)).toEqual([
        'review_document:InteractionSubmitted',
        'send:ApprovalRequested'
      ])
    }
  })

  it('gives each card its own result message', () => {
    // A result belongs to the last part with its id before it: the later call has none yet.
    expect(cards(transcript, [])).toEqual(['review_document:Completed', 'send:Called'])

    const accepted = makeBackgroundToolAcceptedResult({
      toolCallId: 'call_0',
      acceptance: BackgroundToolAccepted.make({ version: 1, executionId: 'owner:review' })
    })

    // An earlier turn's background acknowledgement never hides a later call's pending approval.
    const acknowledged = [
      turn('Reviewing', review),
      toolResultMessageFromResult(accepted),
      turn('Sending', send)
    ]

    expect(cards(acknowledged, pending)).toEqual([
      'review_document:Accepted',
      'send:ApprovalRequested'
    ])
  })

  it('gives one run per turn of the same call to its own turn, the latest to the latest', () => {
    const repeated = [turn('Reviewing', review), reviewed, turn('Again', review)]

    const completed = AgentToolRun.Completed({
      call: review,
      result: ToolResult.make({ toolCallId: 'call_0', content: 'Reviewed' }),
      startedAtMs: 1,
      endedAtMs: 2
    })

    const running = AgentToolRun.Executing({ call: review, startedAtMs: 3 })

    expect(cards(repeated, [completed, running])).toEqual([
      'review_document:Completed',
      'review_document:Running'
    ])

    // One run reaches the latest card only; the earlier keeps its message state.
    expect(cards(repeated, [running])).toEqual([
      'review_document:Completed',
      'review_document:Running'
    ])
  })

  it('keeps the last run when several runs hold the same call', () => {
    const executing = AgentToolRun.Executing({ call: send, startedAtMs: 3 })

    expect(cards(transcript, [executing, ...pending])).toEqual([
      'review_document:Completed',
      'send:ApprovalRequested'
    ])

    expect(cards(transcript, [...pending, executing])).toEqual([
      'review_document:Completed',
      'send:Running'
    ])
  })

  it('shows a run holding a call no card holds nowhere', () => {
    // Another turn's call reusing the id, whose message is not in `messages` yet.
    const other = ToolCall.make({ id: 'call_0', name: 'delete', params: {} })

    expect(cards(transcript, [AgentToolRun.InputReady({ call: other })])).toEqual([
      'review_document:Completed',
      'send:Called'
    ])
  })

  describe('a run that holds no call falls back to the last card with its id', () => {
    it('with one card', () => {
      expect(
        cards(
          [turn('Sending', send)],
          [AgentToolRun.InputStreaming({ id: 'call_0', input: '{"to"' })]
        )
      ).toEqual(['send:InputStreaming'])

      expect(
        cards(
          [turn('Sending', send)],
          [AgentToolRun.Denied({ toolCallId: 'call_0', reason: 'No' })]
        )
      ).toEqual(['send:Denied'])
    })

    it('with a card per turn: the latest takes it, the earlier keeps its message state', () => {
      expect(cards(transcript, [acceptedInteraction])).toEqual([
        'review_document:Completed',
        'send:InteractionSubmitted'
      ])
    })

    it('after the runs holding calls took theirs', () => {
      const denied = AgentToolRun.Denied({ toolCallId: 'call_0', reason: 'No' })

      expect(cards(transcript, [denied, ...pending])).toEqual([
        'review_document:Denied',
        'send:ApprovalRequested'
      ])

      // Runs without a call go latest first: the last one to the latest card left.
      expect(cards(transcript, [denied, acceptedInteraction])).toEqual([
        'review_document:Denied',
        'send:InteractionSubmitted'
      ])
    })
  })
})
