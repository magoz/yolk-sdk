import { describe, expect, it } from '@effect/vitest'
import {
  AgentEnd,
  AgentStart,
  AssistantAgentMessage,
  AssistantMessageEvent,
  AssistantTextPart,
  HostToolCallPart,
  LLMStreamEnd,
  LLMStreamStart,
  LLMTextDelta,
  QuestionAnswer,
  QuestionAnswered,
  QuestionPrompt,
  QuestionRequest,
  QuestionRequested,
  QuestionResponse,
  ToolCall,
  ToolExecutionCompleted,
  ToolExecutionStarted,
  ToolInputDelta,
  ToolInputEnd,
  ToolInputStart,
  ToolResult,
  ToolResultMessage,
  UserMessage,
  zeroAgentUsage,
  type AgentEvent,
  type AgentMessage
} from '@yolk-sdk/agent/protocol'
import {
  makeAgentChatEventProjectionState,
  markChatRunStart,
  stepAgentChatProjection,
  stepAgentChatProjectionAll
} from '../../src/chat/chat-core.ts'
import {
  applyAgentEventToChatMessages,
  buildAgentChatMessages
} from '../../src/chat/chat-messages.ts'
import type {
  AgentChatEventProjectionState,
  AgentChatMessage
} from '../../src/chat/chat-schemas.ts'

/** Exchanges of a question, a call with its result, and an answer. */
const history = (exchanges: number): ReadonlyArray<AgentMessage> =>
  Array.from({ length: exchanges }, (_, exchange) => {
    const call = ToolCall.make({ id: `call-${exchange}`, name: 'search', params: { exchange } })

    return [
      UserMessage.make({ content: `question ${exchange}` }),
      AssistantAgentMessage.make({
        parts: [AssistantTextPart.make({ content: 'looking' }), HostToolCallPart.make({ call })]
      }),
      ToolResultMessage.make({ toolCallId: call.id, content: 'found' }),
      AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'answer' })] })
    ]
  }).flat()

const projectionOf = (messages: ReadonlyArray<AgentMessage>) =>
  markChatRunStart(
    makeAgentChatEventProjectionState(
      buildAgentChatMessages({
        messages,
        userDraft: '',
        assistantDraft: '',
        reasoningDraft: '',
        toolRuns: [],
        error: null
      })
    )
  )

const fold = (state: AgentChatEventProjectionState, events: ReadonlyArray<AgentEvent>) =>
  events.reduce((current, event) => stepAgentChatProjection(current, event).projection, state)

const tagged = (turn: number, index: number) => ({
  eventId: `run:${turn}:${index}`,
  streamId: 'run',
  executionId: `step:${turn}`,
  executionTurn: turn
})

/** One tagged model turn streaming text and a call, then its untagged tool batch. */
const turnEvents = (turn: number): ReadonlyArray<AgentEvent> => {
  const call = ToolCall.make({ id: `live-${turn}`, name: 'search', params: { turn } })

  return [
    LLMStreamStart.make({ ...tagged(turn, 0), turn }),
    LLMTextDelta.make({ ...tagged(turn, 1), text: 'hel' }),
    LLMTextDelta.make({ ...tagged(turn, 2), text: 'lo' }),
    ToolInputStart.make({ ...tagged(turn, 3), id: call.id, name: call.name }),
    ToolInputDelta.make({ ...tagged(turn, 4), id: call.id, delta: '{}' }),
    ToolInputEnd.make({ ...tagged(turn, 5), call }),
    AssistantMessageEvent.make({
      ...tagged(turn, 6),
      message: AssistantAgentMessage.make({
        parts: [AssistantTextPart.make({ content: 'hello' }), HostToolCallPart.make({ call })]
      })
    }),
    LLMStreamEnd.make({ ...tagged(turn, 7), turn }),
    ToolExecutionStarted.make({ eventId: `run:${turn}:8`, streamId: 'run', call }),
    ToolExecutionCompleted.make({
      eventId: `run:${turn}:9`,
      streamId: 'run',
      call,
      result: ToolResult.make({ toolCallId: call.id, content: 'done' })
    })
  ]
}

const sameReferences = (
  before: ReadonlyArray<AgentChatMessage>,
  after: ReadonlyArray<AgentChatMessage>
) => before.every((message, index) => after[index] === message)

describe('chat projection identity', () => {
  it('keeps every message an event did not change, by reference', () => {
    const start = projectionOf(history(20))
    const events = [...turnEvents(1), ...turnEvents(2)]

    const folded: Array<AgentChatEventProjectionState> = [start]

    for (const event of events) {
      folded.push(stepAgentChatProjection(folded.at(-1) ?? start, event).projection)
    }

    expect(folded.every(state => sameReferences(start.chatMessages, state.chatMessages))).toBe(true)

    // Each event changes at most the chat's last message, or adds one.
    folded.slice(1).forEach((state, index) => {
      const previous = folded[index]?.chatMessages ?? []

      expect(sameReferences(previous.slice(0, -1), state.chatMessages)).toBe(true)
    })

    expect(folded.at(-1)?.chatMessages.length).toBe(start.chatMessages.length + 2)
  })

  it('keeps the history at the run end and a run start', () => {
    const start = projectionOf(history(5))
    const end = AgentEnd.make({ eventId: 'run:end', messages: [], turns: 1, usage: zeroAgentUsage })

    const ended = fold(start, [...turnEvents(1), end])
    const restarted = stepAgentChatProjection(ended, AgentStart.make({ eventId: 'run:start' }))

    expect(sameReferences(start.chatMessages, ended.chatMessages)).toBe(true)
    expect(sameReferences(ended.chatMessages, restarted.projection.chatMessages)).toBe(true)
    expect(restarted.projection.chatMessages).toBe(ended.chatMessages)
  })

  it('returns the same messages when an event changes nothing', () => {
    const call = ToolCall.make({ id: 'ask', name: 'question', params: {} })

    const request = QuestionRequest.make({
      requestId: 'question:ask',
      toolCallId: call.id,
      call,
      questions: [QuestionPrompt.make({ id: 'choice', prompt: 'Pick one' })]
    })

    const response = QuestionResponse.make({
      requestId: request.requestId,
      toolCallId: call.id,
      outcome: 'answered',
      source: 'user',
      answers: [QuestionAnswer.make({ questionId: 'choice', customAnswer: 'A' })]
    })

    const answered = [
      ToolInputEnd.make({ call }),
      QuestionRequested.make({ request }),
      QuestionAnswered.make({ response })
    ].reduce<ReadonlyArray<AgentChatMessage>>(
      (messages, event) => applyAgentEventToChatMessages(messages, event),
      []
    )

    // A replayed request of an answered call changes no part, and a delta of an unknown call none.
    expect(applyAgentEventToChatMessages(answered, QuestionRequested.make({ request }))).toBe(
      answered
    )

    expect(
      applyAgentEventToChatMessages(answered, ToolInputDelta.make({ id: 'other', delta: '{' }))
    ).toBe(answered)
  })

  it('folds a batch as the steps do, with their status events in order', () => {
    const start = projectionOf(history(3))

    // A mid-turn rebuild: turn 1's start was missed, so its first delta brings `missedStart`.
    const events = [...turnEvents(1).slice(1), ...turnEvents(2), ...turnEvents(2)]

    const stepped = events.reduce<{
      readonly projection: AgentChatEventProjectionState
      readonly statusEvents: ReadonlyArray<AgentEvent>
    }>(
      (folded, event) => {
        const step = stepAgentChatProjection(folded.projection, event)

        return {
          projection: step.projection,
          statusEvents: [
            ...folded.statusEvents,
            ...(step.missedStart === undefined ? [] : [step.missedStart]),
            ...(step.statusEvent === undefined ? [] : [step.statusEvent])
          ]
        }
      },
      { projection: start, statusEvents: [] }
    )

    const batch = stepAgentChatProjectionAll(start, events)

    expect(batch.projection).toEqual(stepped.projection)
    expect(batch.statusEvents).toEqual(stepped.statusEvents)
    expect(batch.statusEvents[0]?._tag).toBe('LLMStreamStart')
    expect(batch.messageIdsChanged).toBe(true)
    expect(sameReferences(start.chatMessages, batch.projection.chatMessages)).toBe(true)
  })

  it('says whether the message ids changed', () => {
    const start = projectionOf(history(3))
    const [streamStart, ...deltas] = turnEvents(1).slice(0, 3)

    const started = stepAgentChatProjectionAll(start, [streamStart, ...deltas.slice(0, 1)])

    expect(started.messageIdsChanged).toBe(true)

    // Deltas change the streaming message, never the list of ids.
    const streamed = stepAgentChatProjectionAll(started.projection, deltas.slice(1))

    expect(streamed.messageIdsChanged).toBe(false)
    expect(streamed.projection.chatMessages).not.toBe(started.projection.chatMessages)

    expect(
      sameReferences(started.projection.chatMessages.slice(0, -1), streamed.projection.chatMessages)
    ).toBe(true)

    // A batch of events seen before changes nothing.
    const replayed = stepAgentChatProjectionAll(streamed.projection, [streamStart, ...deltas])

    expect(replayed).toEqual({
      projection: streamed.projection,
      statusEvents: [],
      messageIdsChanged: false
    })

    expect(replayed.projection).toBe(streamed.projection)
  })
})
