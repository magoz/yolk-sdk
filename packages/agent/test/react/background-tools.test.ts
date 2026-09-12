import { Effect, Equal, Option, Predicate } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentEvent,
  AgentEnd,
  zeroAgentUsage,
  AgentStart,
  AssistantAgentMessage,
  AssistantTextPart,
  AssistantMessageEvent,
  HostToolCallPart,
  QuestionRequested,
  QuestionRequest,
  QuestionPrompt,
  QuestionOption,
  ToolInputStart,
  ToolInputDelta,
  ToolInputEnd,
  ToolApprovalRequested,
  ToolApprovalRequest,
  ToolApprovalPolicy,
  UserMessage,
  UserMessageEvent,
  BackgroundToolAccepted,
  ToolCall,
  ToolResult,
  toolResultMessageFromResult,
  ToolExecutionAccepted,
  ToolExecutionStarted,
  makeBackgroundToolAcceptedResult
} from '@yolk-sdk/agent/protocol'
import {
  applyAgentEvent,
  completedToolRuns,
  initialAgentClientState,
  isActiveToolRun
} from '../../src/client/state.ts'
import {
  applyAgentEventToChatMessages,
  reduceAgentChatState,
  initialAgentChatState,
  buildAgentChatMessages,
  toAgentMessages
} from '@yolk-sdk/agent/react'
import { buildAgentChatItems } from '../../src/react/chat-items.ts'
import { getActiveChatToolParts, getCompletedChatToolParts } from '../../src/react/chat-core.ts'

const call = ToolCall.make({
  id: 'work',
  name: 'work',
  params: { execution: 'background', arguments: {} }
})

const result = makeBackgroundToolAcceptedResult({
  toolCallId: call.id,
  acceptance: BackgroundToolAccepted.make({ version: 1, executionId: 'owner:work' })
})

const accepted = ToolExecutionAccepted.make({
  call,
  result,
  eventId: 'accepted:work',
  createdAtMs: 20
})

const started = ToolExecutionStarted.make({ call, createdAtMs: 10 })

describe('background acceptance projection', () => {
  it.effect('round trips the receipt in the distinct wire event', () =>
    Effect.gen(function* () {
      const wire = yield* Schema.encodeEffect(AgentEvent)(accepted)

      const decoded = yield* Schema.decodeUnknownEffect(AgentEvent)(
        JSON.parse(JSON.stringify(wire))
      )

      expect(decoded).toEqual(accepted)
    })
  )

  it('settles client pending input without claiming execution completion and deduplicates receipt replay', () => {
    const state = applyAgentEvent(applyAgentEvent(initialAgentClientState, started), accepted)
    expect(state.toolRuns[0]).toMatchObject({ _tag: 'Accepted', result })
    expect(state.toolRuns.some(isActiveToolRun)).toBe(false)
    expect(completedToolRuns(state.toolRuns)).toEqual([])
    expect(applyAgentEvent(state, accepted)).toEqual(state)
  })

  it('preserves one acknowledgement through live cards, transcript serialization and cold replay', () => {
    const chat = applyAgentEventToChatMessages(applyAgentEventToChatMessages([], started), accepted)

    const items = buildAgentChatItems({
      messages: chat,
      isRunning: false,
      activeToolLabel: Option.none()
    })

    expect(items.filter(item => Predicate.isTagged(item, 'ToolRun'))).toMatchObject([
      { state: { _tag: 'Accepted', result } }
    ])
    // Acceptance settles the card: it is neither an active spinner nor a completed execution.
    expect(getActiveChatToolParts(chat)).toEqual([])
    expect(getCompletedChatToolParts(chat)).toEqual([])
    const transcript = toAgentMessages(chat)
    expect(transcript.filter(message => Predicate.isTagged(message, 'ToolResult'))).toMatchObject([
      { toolCallId: call.id, acceptance: result.acceptance }
    ])

    const replay = buildAgentChatMessages({
      messages: transcript,
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [],
      error: null
    })

    const replayItems = buildAgentChatItems({
      messages: replay,
      isRunning: false,
      activeToolLabel: Option.none()
    })

    expect(replayItems.filter(item => Predicate.isTagged(item, 'ToolRun'))).toMatchObject([
      { state: { _tag: 'Accepted', result } }
    ])
    expect(
      toAgentMessages(replay).filter(message => Predicate.isTagged(message, 'ToolResult'))
    ).toHaveLength(1)
    // A late replayed Started event must not turn the settled card back into a spinner.
    expect(applyAgentEventToChatMessages(chat, started)).toEqual(chat)
  })
})

// Replays intentionally carry no event IDs and conflicting names/arguments.
it('preserves the whole accepted call across all active replays, end and a new turn', () => {
  const changed = ToolCall.make({ ...call, name: 'replayed-name', params: { changed: true } })

  let reducerState = reduceAgentChatState(initialAgentChatState, {
    _tag: 'Event',
    event: ToolExecutionAccepted.make({ call, result })
  })

  const apply = (event: AgentEvent) => {
    reducerState = reduceAgentChatState(reducerState, { _tag: 'Event', event })

    return reducerState.chatMessages
  }

  let chat = reducerState.chatMessages
  const transcript = toAgentMessages(chat)

  const activeEvents = [
    ToolInputStart.make({ id: call.id, name: changed.name }),
    ToolInputDelta.make({ id: call.id, delta: '{"changed":true}' }),
    ToolInputEnd.make({ call: changed }),
    ToolExecutionStarted.make({ call: changed }),
    ToolApprovalRequested.make({
      call: changed,
      request: ToolApprovalRequest.make({
        requestId: 'old',
        toolCallId: call.id,
        call: changed,
        policy: ToolApprovalPolicy.make({ mode: 'manual' })
      })
    }),
    QuestionRequested.make({
      request: QuestionRequest.make({
        requestId: 'old-question',
        toolCallId: call.id,
        call: changed,
        questions: [
          QuestionPrompt.make({
            id: 'q',
            prompt: 'Pick',
            options: [QuestionOption.make({ id: 'a', label: 'A' })]
          })
        ]
      })
    }),
    AssistantMessageEvent.make({
      message: AssistantAgentMessage.make({ parts: [HostToolCallPart.make({ call: changed })] })
    })
  ]

  for (const boundary of [
    undefined,
    AgentEnd.make({ messages: transcript, turns: 1, usage: zeroAgentUsage }),
    AgentStart.make({}),
    UserMessageEvent.make({ message: UserMessage.make({ content: 'next turn' }) })
  ]) {
    if (boundary !== undefined) chat = apply(boundary)

    for (const event of activeEvents) {
      chat = apply(event)

      const parts = chat
        .flatMap(message => message.parts)
        .filter(part => Predicate.isTagged(part, 'ToolCall') && part.call.id === call.id)

      expect(parts).toHaveLength(1)
      expect(parts[0]).toMatchObject({ call, state: { _tag: 'Accepted', result } })
      expect(
        toAgentMessages(chat).filter(message => Predicate.isTagged(message, 'ToolResult'))
      ).toEqual(transcript.filter(message => Predicate.isTagged(message, 'ToolResult')))
      expect(getActiveChatToolParts(chat)).toEqual([])
    }
  }

  chat = apply(ToolExecutionStarted.make({ call: ToolCall.make({ ...call, id: 'sibling' }) }))

  for (const event of activeEvents) {
    chat = apply(event)
    expect(getActiveChatToolParts(chat)).toHaveLength(1)
    expect(
      toAgentMessages(chat).filter(message => Predicate.isTagged(message, 'ToolResult'))
    ).toEqual(transcript.filter(message => Predicate.isTagged(message, 'ToolResult')))
  }
})

it('gives a persisted acceptance precedence over stale active client runs on hydration', () => {
  const transcript = toAgentMessages(applyAgentEventToChatMessages([], accepted))

  for (const event of [
    started,
    ToolInputStart.make({ id: call.id }),
    ToolInputEnd.make({ call })
  ]) {
    const state = applyAgentEvent(initialAgentClientState, event)

    const chat = buildAgentChatMessages({
      messages: transcript,
      toolRuns: state.toolRuns,
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      error: null
    })

    expect(getActiveChatToolParts(chat)).toEqual([])
    expect(toAgentMessages(chat)).toEqual(transcript)
  }
})

it('keeps active siblings in the same assistant message when an accepted call is replayed', () => {
  const sibling = ToolCall.make({ ...call, id: 'sibling' })
  let state = reduceAgentChatState(initialAgentChatState, { _tag: 'Event', event: started })
  state = reduceAgentChatState(state, {
    _tag: 'Event',
    event: ToolExecutionStarted.make({ call: sibling })
  })
  state = reduceAgentChatState(state, { _tag: 'Event', event: accepted })
  const original = state.chatMessages
  state = reduceAgentChatState(state, {
    _tag: 'Event',
    event: AssistantMessageEvent.make({
      message: AssistantAgentMessage.make({
        parts: [
          HostToolCallPart.make({ call: ToolCall.make({ ...call, params: { changed: true } }) })
        ]
      })
    })
  })
  expect(state.chatMessages).toEqual(original)
  expect(getActiveChatToolParts(state.chatMessages)).toMatchObject([{ call: sibling }])
})

it('preserves accepted calls and active siblings through mixed assistant replays across messages', () => {
  const sibling = ToolCall.make({ ...call, id: 'sibling' })
  const replayed = ToolCall.make({ ...call, name: 'stale', params: { changed: true } })

  for (const separateMessages of [false, true]) {
    const events = separateMessages
      ? [accepted, ToolExecutionStarted.make({ call: sibling })]
      : [started, ToolExecutionStarted.make({ call: sibling }), accepted]

    let state = events.reduce(
      (current, event) => reduceAgentChatState(current, { _tag: 'Event', event }),
      initialAgentChatState
    )

    for (const parts of [
      [
        AssistantTextPart.make({ content: 'replayed text' }),
        HostToolCallPart.make({ call: replayed })
      ],
      [HostToolCallPart.make({ call: replayed }), HostToolCallPart.make({ call: sibling })],
      [HostToolCallPart.make({ call: sibling })]
    ]) {
      for (let retry = 0; retry < 2; retry++) {
        state = reduceAgentChatState(state, {
          _tag: 'Event',
          event: AssistantMessageEvent.make({ message: AssistantAgentMessage.make({ parts }) })
        })

        const calls = state.chatMessages
          .flatMap(message => message.parts)
          .filter(part => Predicate.isTagged(part, 'ToolCall'))

        expect(calls.filter(part => part.call.id === call.id)).toMatchObject([
          { call, state: { _tag: 'Accepted', result } }
        ])
        expect(getActiveChatToolParts(state.chatMessages)).toMatchObject([{ call: sibling }])
        const transcript = toAgentMessages(state.chatMessages)
        expect(transcript.filter(message => Predicate.isTagged(message, 'ToolResult'))).toEqual([
          toolResultMessageFromResult(result)
        ])
        expect(
          transcript
            .flatMap(message => (Predicate.isTagged(message, 'Assistant') ? message.parts : []))
            .filter(part => Predicate.isTagged(part, 'HostToolCall'))
            .map(part => part.call.id)
            .sort()
        ).toEqual([sibling.id, call.id].sort())
      }
    }
  }
})

it('hydrates accepted receipts through the public hook reducer and fences subsequent replays', () => {
  const envelope = {
    createdAtMs: 42,
    author: { displayName: 'Host' },
    annotations: { source: 'saved' }
  }

  const assistant = AssistantAgentMessage.make({ parts: [HostToolCallPart.make({ call })] })
  const acknowledgement = toolResultMessageFromResult(result, envelope)
  const transcript = [assistant, acknowledgement]

  let state = transcript.reduce(
    (current, message) => reduceAgentChatState(current, { _tag: 'HydrateMessage', message }),
    initialAgentChatState
  )

  const assertSettled = () => {
    const parts = state.chatMessages.flatMap(message => message.parts)
    expect(parts.filter(part => Predicate.isTagged(part, 'ToolResult'))).toEqual([])
    expect(parts.filter(part => Predicate.isTagged(part, 'ToolCall'))).toMatchObject([
      { call, state: { _tag: 'Accepted', result } }
    ])
    expect(getActiveChatToolParts(state.chatMessages)).toEqual([])
    expect(getCompletedChatToolParts(state.chatMessages)).toEqual([])
    expect(toAgentMessages(state.chatMessages)).toEqual(transcript)
  }

  assertSettled()
  const changed = ToolCall.make({ ...call, name: 'stale', params: { changed: true } })

  for (const event of [
    ToolInputStart.make({ id: call.id, name: changed.name }),
    ToolInputEnd.make({ call: changed }),
    ToolExecutionStarted.make({ call: changed }),
    AssistantMessageEvent.make({ message: assistant }),
    ToolExecutionAccepted.make({ call, result })
  ]) {
    state = reduceAgentChatState(state, { _tag: 'Event', event })
    assertSettled()
  }

  state = reduceAgentChatState(state, { _tag: 'HydrateMessage', message: acknowledgement })
  assertSettled()
})

it('projects only result fields from hydrated messages, never their tag or envelope', () => {
  for (const original of [result, ToolResult.make({ toolCallId: call.id, content: 'completed' })]) {
    const message = toolResultMessageFromResult(original, {
      createdAtMs: 42,
      author: { displayName: 'Host' },
      annotations: { source: 'saved' }
    })

    const chat = buildAgentChatMessages({
      messages: [AssistantAgentMessage.make({ parts: [HostToolCallPart.make({ call })] }), message],
      toolRuns: [],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      error: null
    })

    const part = chat.flatMap(item => item.parts).find(item => Predicate.isTagged(item, 'ToolCall'))
    expect(part?._tag).toBe('ToolCall')

    if (
      part?._tag !== 'ToolCall' ||
      (!Predicate.isTagged(part.state, 'Accepted') && !Predicate.isTagged(part.state, 'Completed'))
    ) {
      throw new Error('Expected settled tool call')
    }

    expect(part.state.result).toStrictEqual(original)
    expect(Equal.equals(part.state.result, original)).toBe(true)
  }
})
