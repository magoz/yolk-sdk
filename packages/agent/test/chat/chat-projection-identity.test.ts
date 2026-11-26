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
  initialAgentChatState,
  makeAgentChatEventProjectionState,
  markChatRunStart,
  reduceAgentChatState,
  stepAgentChatProjection,
  stepAgentChatProjectionAll
} from '../../src/chat/chat-core.ts'
import { AgentChatAction } from '../../src/chat/chat-actions.ts'
import {
  applyAgentEventToChatMessages,
  buildAgentChatMessages
} from '../../src/chat/chat-messages.ts'
import type {
  AgentChatEventProjectionState,
  AgentChatMessage,
  AgentChatState
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

const reduceEvents = (state: AgentChatState, events: ReadonlyArray<AgentEvent>) =>
  events.reduce(
    (current, event) => reduceAgentChatState(current, AgentChatAction.Event({ event })),
    state
  )

const taggedEvent = (turn: number, index: number, attempt = 1, run = 'run') => ({
  eventId: `${run}:${turn}:${attempt}:${index}`,
  streamId: run,
  executionId: `${run}:step:${turn}:${attempt}`,
  executionTurn: turn
})

/** One tagged model turn streaming text and a call, then its untagged tool batch. */
const turnEvents = (turn: number, attempt = 1, run = 'run'): ReadonlyArray<AgentEvent> => {
  const call = ToolCall.make({ id: `live-${turn}`, name: 'search', params: { turn } })
  const tagged = (index: number) => taggedEvent(turn, index, attempt, run)

  return [
    LLMStreamStart.make({ ...tagged(0), turn }),
    LLMTextDelta.make({ ...tagged(1), text: 'hel' }),
    LLMTextDelta.make({ ...tagged(2), text: 'lo' }),
    ToolInputStart.make({ ...tagged(3), id: call.id, name: call.name }),
    ToolInputDelta.make({ ...tagged(4), id: call.id, delta: '{}' }),
    ToolInputEnd.make({ ...tagged(5), call }),
    AssistantMessageEvent.make({
      ...tagged(6),
      message: AssistantAgentMessage.make({
        parts: [AssistantTextPart.make({ content: 'hello' }), HostToolCallPart.make({ call })]
      })
    }),
    LLMStreamEnd.make({ ...tagged(7), turn }),
    ToolExecutionStarted.make({ eventId: `${run}:${turn}:${attempt}:8`, streamId: run, call }),
    ToolExecutionCompleted.make({
      eventId: `${run}:${turn}:${attempt}:9`,
      streamId: run,
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

  it('keeps the history when a newer execution supersedes a turn', () => {
    const start = projectionOf(history(20))
    const superseded = fold(start, turnEvents(1).slice(0, 5))

    expect(superseded.chatMessages).toHaveLength(start.chatMessages.length + 1)

    // The newer execution's start removes the older one's message and nothing else.
    const [restart, ...rest] = turnEvents(1, 2)
    const restarted = stepAgentChatProjection(superseded, restart).projection

    expect(restarted.chatMessages).toHaveLength(start.chatMessages.length)
    expect(sameReferences(start.chatMessages, restarted.chatMessages)).toBe(true)

    const shown = fold(restarted, rest)

    expect(sameReferences(start.chatMessages, shown.chatMessages)).toBe(true)
    expect(shown.chatMessages).toHaveLength(start.chatMessages.length + 1)
  })

  it('keeps the messages a regenerate, edit or delete leaves, through the next run', () => {
    const chat = reduceEvents(
      { ...initialAgentChatState, chatMessages: projectionOf(history(10)).chatMessages },
      turnEvents(1)
    )

    // Each exchange shows as three rows: the question, the call with its result, the answer.
    const user = chat.chatMessages[15]
    const target = chat.chatMessages[17]

    expect(target?.role).toBe('assistant')
    expect(user?.role).toBe('user')

    const regenerated = reduceAgentChatState(
      chat,
      AgentChatAction.RegenerateFrom({ messageId: target?.id ?? '' })
    )

    const edited = reduceAgentChatState(
      chat,
      AgentChatAction.EditUserMessage({ messageId: user?.id ?? '', content: 'again' })
    )

    const deleted = reduceAgentChatState(
      chat,
      AgentChatAction.DeleteTurn({ messageId: target?.id ?? '' })
    )

    expect(regenerated.chatMessages).toEqual(chat.chatMessages.slice(0, 17))
    expect(sameReferences(regenerated.chatMessages, chat.chatMessages)).toBe(true)

    // The edited message is new; every one before it keeps its reference.
    expect(edited.chatMessages).toHaveLength(16)
    expect(sameReferences(edited.chatMessages.slice(0, 15), chat.chatMessages)).toBe(true)
    expect(edited.chatMessages[15]).not.toBe(user)

    // Every message outside the deleted turn keeps its reference, in order.
    expect(deleted.chatMessages.length).toBeLessThan(chat.chatMessages.length)

    expect(
      deleted.chatMessages.every(message => chat.chatMessages.some(kept => kept === message))
    ).toBe(true)

    for (const state of [regenerated, edited, deleted]) {
      const next = reduceEvents(state, turnEvents(1, 1, 'next'))

      expect(sameReferences(state.chatMessages, next.chatMessages)).toBe(true)
      expect(next.chatMessages).toHaveLength(state.chatMessages.length + 1)
    }
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
