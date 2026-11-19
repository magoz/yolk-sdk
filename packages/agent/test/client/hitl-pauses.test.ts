import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import {
  AgentAwaitingInput,
  QuestionAnswer,
  QuestionPrompt,
  QuestionRequest,
  QuestionResponse,
  ToolApprovalRequest,
  ToolApprovalResponse,
  ToolCall,
  UsageUpdate,
  zeroAgentUsage,
  type AgentEvent
} from '@yolk-sdk/agent/protocol'
import {
  HitlPauses,
  emptyHitlPauses,
  hitlPauseFor,
  rememberHitlPause
} from '../../src/client/index.ts'

const approvalRequest = (id: string) =>
  ToolApprovalRequest.make({
    requestId: `approval:${id}`,
    toolCallId: id,
    call: ToolCall.make({ id, name: 'write', params: {} })
  })

const pauseRequests = (
  ids: readonly [string, ...string[]]
): readonly [ToolApprovalRequest, ...ToolApprovalRequest[]] => [
  approvalRequest(ids[0]),
  ...ids.slice(1).map(approvalRequest)
]

const pauseFields = (ids: readonly [string, ...string[]]) => ({
  requests: pauseRequests(ids),
  messages: [],
  turns: 1,
  usage: zeroAgentUsage
})

const awaiting = (eventId: string, ids: readonly [string, ...string[]]) =>
  AgentAwaitingInput.make({ eventId, ...pauseFields(ids) })

const unnamedAwaiting = (ids: readonly [string, ...string[]]) =>
  AgentAwaitingInput.make(pauseFields(ids))

const approve = (id: string) =>
  ToolApprovalResponse.make({
    requestId: `approval:${id}`,
    toolCallId: id,
    decision: 'approved',
    source: 'user'
  })

const remember = (events: ReadonlyArray<AgentEvent>, pauses: HitlPauses = emptyHitlPauses) =>
  events.reduce(rememberHitlPause, pauses)

describe('HITL pause naming', () => {
  it('names the latest pause that asked for each request', () => {
    const pauses = remember([
      awaiting('workflow:run:1:4', ['a', 'b']),
      UsageUpdate.make({ eventId: 'workflow:run:1:5', usage: zeroAgentUsage }),
      awaiting('workflow:run:1:7', ['b'])
    ])

    expect(hitlPauseFor(pauses, approve('a'))).toBe('workflow:run:1:4')
    expect(hitlPauseFor(pauses, approve('b'))).toBe('workflow:run:1:7')
  })

  it('moves a request that pends again (an invalid answer) to its new pause', () => {
    const call = ToolCall.make({ id: 'call_q', name: 'question', params: {} })

    const question = QuestionRequest.make({
      requestId: 'question:call_q',
      toolCallId: call.id,
      call,
      questions: [QuestionPrompt.make({ id: 'city', prompt: 'Which city?' })]
    })

    const asked = (eventId: string) =>
      AgentAwaitingInput.make({
        eventId,
        requests: [question],
        messages: [],
        turns: 1,
        usage: zeroAgentUsage
      })

    const answer = QuestionResponse.make({
      requestId: question.requestId,
      toolCallId: call.id,
      outcome: 'answered',
      source: 'user',
      answers: [QuestionAnswer.make({ questionId: 'city', customAnswer: 'Paris' })]
    })

    const first = remember([asked('workflow:run:1:4')])
    const repended = remember([asked('workflow:run:1:9')], first)

    expect(hitlPauseFor(first, answer)).toBe('workflow:run:1:4')
    expect(hitlPauseFor(repended, answer)).toBe('workflow:run:1:9')
  })

  it('ends at the latest pause after a replay or reconnect re-reads the stream', () => {
    const stream = [
      awaiting('workflow:run:1:4', ['a']),
      awaiting('workflow:run:2:3', ['a']),
      awaiting('workflow:run:3:8', ['b'])
    ]

    const live = remember(stream)
    // A reconnect from an earlier index re-reads the later pauses too.
    const reconnected = remember(stream.slice(1), live)
    // A full replay into a fresh map (a reloaded page).
    const replayed = remember(stream)

    for (const pauses of [live, reconnected, replayed]) {
      expect(hitlPauseFor(pauses, approve('a'))).toBe('workflow:run:2:3')
      expect(hitlPauseFor(pauses, approve('b'))).toBe('workflow:run:3:8')
    }
  })

  it('names no pause for a request no pause asked for, or whose latest pause has no event id', () => {
    const pauses = remember([awaiting('workflow:run:1:4', ['a', 'b']), unnamedAwaiting(['a'])])

    expect(hitlPauseFor(emptyHitlPauses, approve('a'))).toBeUndefined()
    expect(hitlPauseFor(pauses, approve('a'))).toBeUndefined()
    expect(hitlPauseFor(pauses, approve('b'))).toBe('workflow:run:1:4')
  })

  it('never mutates its input and keeps it when nothing changes', () => {
    const pauses = remember([awaiting('workflow:run:1:4', ['a'])])
    const next = rememberHitlPause(pauses, awaiting('workflow:run:1:9', ['a']))

    expect(hitlPauseFor(pauses, approve('a'))).toBe('workflow:run:1:4')
    expect(hitlPauseFor(next, approve('a'))).toBe('workflow:run:1:9')
    expect(rememberHitlPause(next, awaiting('workflow:run:1:9', ['a']))).toBe(next)
    expect(rememberHitlPause(next, UsageUpdate.make({ eventId: 'e', usage: zeroAgentUsage }))).toBe(
      next
    )
    expect(rememberHitlPause(emptyHitlPauses, unnamedAwaiting(['a']))).toBe(emptyHitlPauses)
  })

  it.effect('round-trips through JSON with its Schema', () =>
    Effect.gen(function* () {
      const codec = Schema.toCodecJson(HitlPauses)
      const pauses = remember([awaiting('workflow:run:1:4', ['a']), awaiting('p2', ['b'])])
      const encoded = yield* Schema.encodeEffect(codec)(pauses)

      const decoded = yield* Schema.decodeUnknownEffect(codec)(JSON.parse(JSON.stringify(encoded)))

      expect(hitlPauseFor(decoded, approve('a'))).toBe('workflow:run:1:4')
      expect(hitlPauseFor(decoded, approve('b'))).toBe('p2')
    })
  )
})
