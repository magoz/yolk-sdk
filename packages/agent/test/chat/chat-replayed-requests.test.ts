import { Effect, Layer, Match, Predicate, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentAwaitingInput,
  AssistantAgentMessage,
  AssistantMessageEvent,
  AssistantTextPart,
  BackgroundToolAccepted,
  HostToolCallPart,
  InputCancelled,
  InputRequest,
  InputRequested,
  InputResponse,
  InputSubmitted,
  InteractionCancelled,
  InteractionRequest,
  InteractionRequested,
  InteractionResponse,
  InteractionSubmitted,
  LLMStreamStart,
  ProviderToolResult,
  QuestionAnswered,
  QuestionCancelled,
  QuestionPrompt,
  QuestionRequest,
  QuestionRequested,
  QuestionResponse,
  ToolApprovalDenied,
  ToolApprovalPolicy,
  ToolApprovalGranted,
  ToolApprovalRequest,
  ToolApprovalRequested,
  ToolApprovalResponse,
  ToolCall,
  ToolDef,
  ToolExecutionAccepted,
  ToolExecutionCompleted,
  ToolExecutionError,
  ToolExecutionStarted,
  ToolResult,
  UserMessage,
  interactionRequestId,
  makeBackgroundToolAcceptedResult,
  zeroAgentUsage,
  type AgentEvent,
  type HitlRequest,
  type HitlResponse,
  type InputToolHandler
} from '@yolk-sdk/agent/protocol'
import { ContextTransformer, LoopConfig, run, runToolBatch } from '../../src/loop/index.ts'
import { FauxProvider, TestToolExecutor } from '../../src/loop/testing/index.ts'
import { AgentChatAction } from '../../src/chat/chat-actions.ts'
import {
  applyAgentEventToChatProjection,
  initialAgentChatState,
  makeAgentChatEventProjectionState,
  reduceAgentChatState
} from '../../src/chat/chat-core.ts'
import { AgentToolRun } from '../../src/client/state.ts'
import {
  applyAgentEventToChatMessages,
  buildAgentChatMessages
} from '../../src/chat/chat-messages.ts'
import { makeInputToolDef } from '../../src/tools/index.ts'
import type {
  AgentChatEventProjectionState,
  AgentChatMessage,
  AgentChatState,
  ChatToolState
} from '../../src/chat/chat-schemas.ts'

// A request event (or `AgentAwaitingInput` request) replayed after its call settled must not set
// the call back to pending. Every scenario runs through both chat reducers: the event projection
// and the `useAgentChat` reducer.

type Chats = {
  readonly projection: AgentChatEventProjectionState
  readonly chat: AgentChatState
}

const initialChats: Chats = {
  projection: makeAgentChatEventProjectionState(),
  chat: initialAgentChatState
}

const applyEvent = (chats: Chats, event: AgentEvent): Chats => ({
  projection: applyAgentEventToChatProjection(chats.projection, event),
  chat: reduceAgentChatState(chats.chat, AgentChatAction.Event({ event }))
})

const applyEvents = (chats: Chats, events: ReadonlyArray<AgentEvent>) =>
  events.reduce(applyEvent, chats)

/** A local answer: only the `useAgentChat` reducer submits; the projection sees server events. */
const submit = (chats: Chats, response: HitlResponse): Chats => ({
  ...chats,
  chat: reduceAgentChatState(chats.chat, AgentChatAction.SubmitHitlResponse({ response }))
})

const toolStates = (messages: ReadonlyArray<AgentChatMessage>): ReadonlyArray<ChatToolState> =>
  messages.flatMap(message =>
    message.parts.flatMap(part => (Predicate.isTagged(part, 'ToolCall') ? [part.state] : []))
  )

const stateTags = (chats: Chats) => ({
  projection: toolStates(chats.projection.chatMessages).map(state => state._tag),
  chat: toolStates(chats.chat.chatMessages).map(state => state._tag)
})

const both = <Value>(value: Value) => ({ projection: value, chat: value })

const toolCallId = 'call_0'

const ask = (call: ToolCall) =>
  AssistantAgentMessage.make({
    parts: [AssistantTextPart.make({ content: 'One moment' }), HostToolCallPart.make({ call })]
  })

const done = AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'Done' })] })

const result = ToolResult.make({ toolCallId, content: 'ok' })

type Settle = {
  readonly name: string
  readonly state: ChatToolState['_tag']
  readonly events: (eventId: (step: string) => string) => ReadonlyArray<AgentEvent>
}

type Kind = {
  readonly name: string
  readonly call: ToolCall
  readonly request: HitlRequest
  readonly requested: (eventId?: string) => AgentEvent
  readonly settles: ReadonlyArray<Settle>
}

const ran = (call: ToolCall, eventId: (step: string) => string): ReadonlyArray<AgentEvent> => [
  ToolExecutionStarted.make({ eventId: eventId('started'), call }),
  ToolExecutionCompleted.make({ eventId: eventId('completed'), call, result })
]

const approval = (): Kind => {
  const call = ToolCall.make({ id: toolCallId, name: 'deploy', params: { env: 'prod' } })

  const request = ToolApprovalRequest.make({
    requestId: `approval:${toolCallId}`,
    toolCallId,
    call
  })

  const response = (decision: 'approved' | 'denied') =>
    ToolApprovalResponse.make({
      requestId: request.requestId,
      toolCallId,
      decision,
      source: 'user'
    })

  const granted = (eventId: (step: string) => string) =>
    ToolApprovalGranted.make({
      eventId: eventId('granted'),
      toolCallId,
      response: response('approved')
    })

  return {
    name: 'approval',
    call,
    request,
    requested: eventId => ToolApprovalRequested.make({ eventId, call, request }),
    settles: [
      {
        name: 'denied',
        state: 'Denied',
        events: eventId => [
          ToolApprovalDenied.make({
            eventId: eventId('denied'),
            toolCallId,
            reason: 'Not now',
            response: response('denied')
          })
        ]
      },
      {
        name: 'completed',
        state: 'Completed',
        events: eventId => [granted(eventId), ...ran(call, eventId)]
      },
      {
        name: 'errored',
        state: 'Errored',
        events: eventId => [
          granted(eventId),
          ToolExecutionStarted.make({ eventId: eventId('started'), call }),
          ToolExecutionError.make({
            eventId: eventId('error'),
            call,
            message: 'Deploy failed',
            code: 'tool_error'
          })
        ]
      }
    ]
  }
}

const question = (): Kind => {
  const call = ToolCall.make({ id: toolCallId, name: 'question', params: { topic: 'unit' } })

  const request = QuestionRequest.make({
    requestId: `question:${toolCallId}`,
    toolCallId,
    call,
    questions: [QuestionPrompt.make({ id: 'unit', prompt: 'Celsius or Fahrenheit?' })]
  })

  const answered = QuestionResponse.make({
    requestId: request.requestId,
    toolCallId,
    outcome: 'answered',
    source: 'user',
    answers: []
  })

  const cancelled = QuestionResponse.make({
    requestId: request.requestId,
    toolCallId,
    outcome: 'cancelled',
    source: 'user'
  })

  return {
    name: 'question',
    call,
    request,
    requested: eventId => QuestionRequested.make({ eventId, request }),
    settles: [
      {
        name: 'answered',
        state: 'QuestionAnswered',
        events: eventId => [
          QuestionAnswered.make({ eventId: eventId('answered'), response: answered })
        ]
      },
      {
        name: 'cancelled',
        state: 'QuestionCancelled',
        events: eventId => [
          QuestionCancelled.make({ eventId: eventId('cancelled'), response: cancelled })
        ]
      },
      {
        name: 'completed',
        state: 'Completed',
        events: eventId => [
          QuestionAnswered.make({ eventId: eventId('answered'), response: answered }),
          ToolExecutionCompleted.make({ eventId: eventId('completed'), call, result })
        ]
      }
    ]
  }
}

const input = (): Kind => {
  const call = ToolCall.make({ id: toolCallId, name: 'word', params: {} })

  const request = InputRequest.make({
    requestId: `input:word:${toolCallId}`,
    toolCallId,
    call,
    input: { kind: 'text-field', title: 'Word' }
  })

  const submitted = InputResponse.make({
    requestId: request.requestId,
    toolCallId,
    outcome: 'submitted',
    source: 'user',
    data: 'kind'
  })

  const cancelled = InputResponse.make({
    requestId: request.requestId,
    toolCallId,
    outcome: 'cancelled',
    source: 'user'
  })

  return {
    name: 'input',
    call,
    request,
    requested: eventId => InputRequested.make({ eventId, request }),
    settles: [
      {
        name: 'submitted',
        state: 'InputSubmitted',
        events: eventId => [
          InputSubmitted.make({ eventId: eventId('submitted'), response: submitted })
        ]
      },
      {
        name: 'cancelled',
        state: 'InputCancelled',
        events: eventId => [
          InputCancelled.make({ eventId: eventId('cancelled'), response: cancelled })
        ]
      },
      {
        name: 'completed',
        state: 'Completed',
        events: eventId => [
          InputSubmitted.make({ eventId: eventId('submitted'), response: submitted }),
          ToolExecutionCompleted.make({ eventId: eventId('completed'), call, result })
        ]
      }
    ]
  }
}

const interaction = (): Kind => {
  const call = ToolCall.make({ id: toolCallId, name: 'document', params: {} })

  const request = InteractionRequest.make({
    requestId: interactionRequestId(call),
    toolCallId,
    call,
    interaction: {
      kind: 'document-editor',
      title: 'Review document',
      actions: [{ id: 'publish', label: 'Publish' }]
    }
  })

  const submitted = InteractionResponse.make({
    requestId: request.requestId,
    toolCallId,
    outcome: 'submitted',
    source: 'user',
    actionId: 'publish',
    data: { title: 'Edited' }
  })

  const cancelled = InteractionResponse.make({
    requestId: request.requestId,
    toolCallId,
    outcome: 'cancelled',
    source: 'user'
  })

  return {
    name: 'interaction',
    call,
    request,
    requested: eventId => InteractionRequested.make({ eventId, request }),
    settles: [
      {
        name: 'submitted',
        state: 'InteractionSubmitted',
        events: eventId => [
          InteractionSubmitted.make({ eventId: eventId('submitted'), response: submitted })
        ]
      },
      {
        name: 'cancelled',
        state: 'InteractionCancelled',
        events: eventId => [
          InteractionCancelled.make({ eventId: eventId('cancelled'), response: cancelled })
        ]
      },
      {
        name: 'completed',
        state: 'Completed',
        events: eventId => [
          InteractionSubmitted.make({ eventId: eventId('submitted'), response: submitted }),
          ...ran(call, eventId)
        ]
      }
    ]
  }
}

const awaiting = (request: HitlRequest, eventId?: string) =>
  AgentAwaitingInput.make({
    eventId,
    requests: [request],
    messages: [],
    turns: 1,
    usage: zeroAgentUsage
  })

const kinds = [approval(), question(), input(), interaction()]

/** Where the replay arrives: in the call's own turn, or after the next turn started. */
const positions = ['in its turn', 'after the next turn started'] as const

type Position = (typeof positions)[number]

type Replay = 'request event without event id' | 'request event with a new event id' | 'pause'

const replays: ReadonlyArray<Replay> = [
  'request event without event id',
  'request event with a new event id',
  'pause'
]

const replayEvent = (kind: Kind, replay: Replay): AgentEvent => {
  if (replay === 'request event without event id') return kind.requested()

  if (replay === 'request event with a new event id') return kind.requested('replayed-request')

  return awaiting(kind.request)
}

const settledChats = (kind: Kind, settle: Settle, position: Position) => {
  const eventId = (step: string) => `run:${step}`

  const nextTurn: ReadonlyArray<AgentEvent> =
    position === 'in its turn'
      ? []
      : [
          LLMStreamStart.make({ eventId: eventId('start-2'), turn: 2 }),
          AssistantMessageEvent.make({ eventId: eventId('message-2'), message: done })
        ]

  return applyEvents(initialChats, [
    LLMStreamStart.make({ eventId: eventId('start-1'), turn: 1 }),
    AssistantMessageEvent.make({ eventId: eventId('message-1'), message: ask(kind.call) }),
    kind.requested(eventId('request')),
    awaiting(kind.request, eventId('pause')),
    ...settle.events(eventId),
    ...nextTurn
  ])
}

describe('a replayed request after its call settled', () => {
  const cases = kinds.flatMap(kind =>
    kind.settles.flatMap(settle =>
      positions.flatMap(position =>
        replays.map(replay => ({
          title: `${kind.name} ${settle.name}, ${position}: ${replay}`,
          kind,
          settle,
          position,
          replay
        }))
      )
    )
  )

  it.each(cases)('keeps the call settled ($title)', ({ kind, settle, position, replay }) => {
    const settled = settledChats(kind, settle, position)

    expect(stateTags(settled)).toEqual(both([settle.state]))

    const replayed = applyEvent(settled, replayEvent(kind, replay))

    expect(replayed.projection.chatMessages).toEqual(settled.projection.chatMessages)
    expect(replayed.chat.chatMessages).toEqual(settled.chat.chatMessages)
    // A replayed pause naming only such calls does not block the run again.
    expect(replayed.chat.status).toEqual(settled.chat.status)
  })
})

describe('a replayed start of a finished call', () => {
  // The same fence as `reduceAgentEvents`: a completed, accepted or errored call keeps its state and
  // the run status when the tool batch's start of the same call replays.
  const kind = approval()

  const cases = kind.settles
    .filter(settle => settle.state === 'Completed' || settle.state === 'Errored')
    .flatMap(settle =>
      positions.flatMap(position =>
        (['without', 'with'] as const).map(ids => ({
          title: `${settle.name}, ${position}, ${ids} event id`,
          settle,
          position,
          ids
        }))
      )
    )

  it.each(cases)('keeps the call and the run status ($title)', ({ settle, position, ids }) => {
    const settled = settledChats(kind, settle, position)

    expect(stateTags(settled)).toEqual(both([settle.state]))

    const replayed = applyEvent(
      settled,
      ToolExecutionStarted.make({
        eventId: ids === 'with' ? 'replayed-start' : undefined,
        call: kind.call
      })
    )

    expect(replayed.projection.chatMessages).toEqual(settled.projection.chatMessages)
    expect(replayed.chat.chatMessages).toEqual(settled.chat.chatMessages)
    expect(replayed.chat.status).toEqual(settled.chat.status)
  })
})

describe('a request for a call still pending', () => {
  it('replaces the pending request with a newer one (a recomputed approval preview)', () => {
    const kind = approval()

    const previewed = ToolApprovalRequest.make({
      requestId: kind.request.requestId,
      toolCallId,
      call: kind.call,
      previewError: { cause: 'timeout', message: 'The preview timed out.' }
    })

    const chats = applyEvents(initialChats, [
      LLMStreamStart.make({ eventId: 'run:start-1', turn: 1 }),
      AssistantMessageEvent.make({ eventId: 'run:message-1', message: ask(kind.call) }),
      kind.requested('run:request'),
      awaiting(kind.request, 'run:pause'),
      ToolApprovalRequested.make({ eventId: 'run:request-2', call: kind.call, request: previewed }),
      awaiting(previewed, 'run:pause-2')
    ])

    const expected = [{ _tag: 'ApprovalRequested', request: previewed }]

    expect(toolStates(chats.projection.chatMessages)).toEqual(expected)
    expect(toolStates(chats.chat.chatMessages)).toEqual(expected)
  })

  it.each(['request event', 'pause'] as const)(
    "adds a later turn's call that reuses the id, leaving the settled one (%s)",
    replay => {
      const kind = question()
      const settle = kind.settles[0]

      const later = ToolCall.make({ id: toolCallId, name: 'question', params: { topic: 'city' } })

      const laterRequest = QuestionRequest.make({
        requestId: `question:${toolCallId}`,
        toolCallId,
        call: later,
        questions: [QuestionPrompt.make({ id: 'city', prompt: 'Which city?' })]
      })

      const chats = applyEvents(settledChats(kind, settle, 'after the next turn started'), [
        LLMStreamStart.make({ eventId: 'run:start-3', turn: 3 }),
        AssistantMessageEvent.make({ eventId: 'run:message-3', message: ask(later) }),
        replay === 'request event'
          ? QuestionRequested.make({ request: laterRequest })
          : awaiting(laterRequest)
      ])

      expect(stateTags(chats)).toEqual(both(['QuestionAnswered', 'QuestionRequested']))

      if (replay === 'pause') {
        expect(chats.chat.status).toMatchObject({ _tag: 'Blocked', requests: [laterRequest] })
      }
    }
  )

  it('blocks only on the pending requests of a pause that also names a settled call', () => {
    // A pause replayed after one of its two calls was answered: the denied approval stays denied,
    // and the run waits on the question alone.
    const deploy = approval()

    const unit = ToolCall.make({ id: 'call_1', name: 'question', params: { topic: 'unit' } })

    const unitRequest = QuestionRequest.make({
      requestId: `question:${unit.id}`,
      toolCallId: unit.id,
      call: unit,
      questions: [QuestionPrompt.make({ id: 'unit', prompt: 'Celsius or Fahrenheit?' })]
    })

    const twoCalls = AssistantAgentMessage.make({
      parts: [HostToolCallPart.make({ call: deploy.call }), HostToolCallPart.make({ call: unit })]
    })

    const pause = (eventId?: string) =>
      AgentAwaitingInput.make({
        eventId,
        requests: [deploy.request, unitRequest],
        messages: [],
        turns: 1,
        usage: zeroAgentUsage
      })

    const answered = applyEvents(initialChats, [
      LLMStreamStart.make({ eventId: 'run:start-1', turn: 1 }),
      AssistantMessageEvent.make({ eventId: 'run:message-1', message: twoCalls }),
      deploy.requested('run:request'),
      QuestionRequested.make({ eventId: 'run:question', request: unitRequest }),
      pause('run:pause'),
      ...(deploy.settles[0]?.events(step => `run:${step}`) ?? [])
    ])

    expect(stateTags(answered)).toEqual(both(['Denied', 'QuestionRequested']))
    expect(answered.chat.status).toMatchObject({ _tag: 'Blocked', kind: 'permission' })

    const replayed = applyEvent(answered, pause())

    expect(stateTags(replayed)).toEqual(both(['Denied', 'QuestionRequested']))

    expect(replayed.chat.status).toMatchObject({
      _tag: 'Blocked',
      kind: 'question',
      requests: [unitRequest]
    })
  })
})

/** A later turn's call of the same tool reusing the id, with other arguments, and its request. */
type Reused = {
  readonly call: ToolCall
  readonly request: HitlRequest
  readonly pending: ChatToolState['_tag']
  readonly requested: (eventId?: string) => AgentEvent
}

const reused = (kind: Kind, params: Record<string, string> = { reused: 'yes' }): Reused => {
  const call = ToolCall.make({ id: toolCallId, name: kind.call.name, params })

  return Match.value(kind.request).pipe(
    Match.withReturnType<Reused>(),
    Match.tag('ToolApprovalRequest', current => {
      const request = ToolApprovalRequest.make({ ...current, call })

      return {
        call,
        request,
        pending: 'ApprovalRequested',
        requested: eventId => ToolApprovalRequested.make({ eventId, call, request })
      }
    }),
    Match.tag('QuestionRequest', current => {
      const request = QuestionRequest.make({ ...current, call })

      return {
        call,
        request,
        pending: 'QuestionRequested',
        requested: eventId => QuestionRequested.make({ eventId, request })
      }
    }),
    Match.tag('InputRequest', current => {
      const request = InputRequest.make({ ...current, call })

      return {
        call,
        request,
        pending: 'InputRequested',
        requested: eventId => InputRequested.make({ eventId, request })
      }
    }),
    Match.tag('InteractionRequest', current => {
      const request = InteractionRequest.make({ ...current, call })

      return {
        call,
        request,
        pending: 'InteractionRequested',
        requested: eventId => InteractionRequested.make({ eventId, request })
      }
    }),
    Match.exhaustive
  )
}

/** Turn 1 settled (`settledChats`, a turn after it); turn 3 asks `later`, still pending. */
const askedLater = (kind: Kind, settle: Settle, later: Reused) =>
  applyEvents(settledChats(kind, settle, 'after the next turn started'), [
    LLMStreamStart.make({ eventId: 'run:start-3', turn: 3 }),
    AssistantMessageEvent.make({ eventId: 'run:message-3', message: ask(later.call) }),
    later.requested('run:request-3'),
    awaiting(later.request, 'run:pause-3')
  ])

/** A tool-batch event as a replay without event id sends it. */
const batchReplay = (event: AgentEvent): ReadonlyArray<AgentEvent> =>
  Match.value(event).pipe(
    Match.withReturnType<ReadonlyArray<AgentEvent>>(),
    Match.tag('ToolExecutionStarted', current => [
      ToolExecutionStarted.make({ call: current.call })
    ]),
    Match.tag('ToolExecutionCompleted', current => [
      ToolExecutionCompleted.make({ call: current.call, result: current.result })
    ]),
    Match.tag('ToolExecutionError', current => [
      ToolExecutionError.make({ call: current.call, message: current.message, code: current.code })
    ]),
    Match.orElse(() => [])
  )

/** An answer as a replay without event id sends it. */
const answerReplay = (event: AgentEvent): ReadonlyArray<AgentEvent> =>
  Match.value(event).pipe(
    Match.withReturnType<ReadonlyArray<AgentEvent>>(),
    Match.tag('QuestionAnswered', current => [
      QuestionAnswered.make({ response: current.response })
    ]),
    Match.tag('QuestionCancelled', current => [
      QuestionCancelled.make({ response: current.response })
    ]),
    Match.tag('InputSubmitted', current => [InputSubmitted.make({ response: current.response })]),
    Match.tag('InputCancelled', current => [InputCancelled.make({ response: current.response })]),
    Match.tag('InteractionSubmitted', current => [
      InteractionSubmitted.make({ response: current.response })
    ]),
    Match.tag('InteractionCancelled', current => [
      InteractionCancelled.make({ response: current.response })
    ]),
    Match.orElse(() => [])
  )

describe("an earlier turn's event replayed after a later turn reused the call id", () => {
  // Turn 1 settles `call_0`; turn 3 asks another `call_0` (same tool, other arguments), still
  // pending. A replay of turn 1's request, pause or tool batch acts on turn 1's part, which keeps
  // its state: turn 3's card, and the status blocked on it, stay. As `reduceAgentEvents`.
  const requestCases = kinds.flatMap(kind =>
    kind.settles.flatMap(settle =>
      replays.map(replay => ({
        title: `${kind.name} ${settle.name}: ${replay}`,
        kind,
        settle,
        replay
      }))
    )
  )

  it.each(requestCases)(
    "keeps the later turn's card pending ($title)",
    ({ kind, settle, replay }) => {
      const later = reused(kind)
      const asked = askedLater(kind, settle, later)

      expect(stateTags(asked)).toEqual(both([settle.state, later.pending]))
      expect(asked.chat.status).toMatchObject({ _tag: 'Blocked', requests: [later.request] })

      const replayed = applyEvent(asked, replayEvent(kind, replay))

      expect(replayed.projection.chatMessages).toEqual(asked.projection.chatMessages)
      expect(replayed.chat.chatMessages).toEqual(asked.chat.chatMessages)
      expect(replayed.chat.status).toEqual(asked.chat.status)
    }
  )

  const batchCases = kinds.flatMap(kind =>
    kind.settles.flatMap(settle =>
      settle
        .events(step => `run:${step}`)
        .flatMap(batchReplay)
        .map(event => ({
          title: `${kind.name} ${settle.name}: ${event._tag}`,
          kind,
          settle,
          event
        }))
    )
  )

  it.each(batchCases)(
    "keeps the later turn's card pending on a tool-batch replay ($title)",
    ({ kind, settle, event }) => {
      const later = reused(kind)
      const asked = askedLater(kind, settle, later)

      const replayed = applyEvent(asked, event)

      expect(replayed.projection.chatMessages).toEqual(asked.projection.chatMessages)
      expect(replayed.chat.chatMessages).toEqual(asked.chat.chatMessages)
      expect(replayed.chat.status).toEqual(asked.chat.status)
    }
  )

  // An answer goes to the part holding its request: turn 3's approval holds another request
  // (`approval:call_0`), so a replayed answer of turn 1's question, input or interaction leaves it.
  const answerCases = [question(), input(), interaction()].flatMap(kind =>
    kind.settles.flatMap(settle =>
      settle
        .events(step => `run:${step}`)
        .flatMap(answerReplay)
        .filter(() => settle.state !== 'Completed')
        .map(event => ({
          title: `${kind.name} ${settle.name}: ${event._tag}`,
          kind,
          settle,
          event
        }))
    )
  )

  it.each(answerCases)(
    "keeps another tool's later card pending on an answer replay ($title)",
    ({ kind, settle, event }) => {
      const later = reused(approval(), { env: 'staging' })
      const asked = askedLater(kind, settle, later)

      expect(stateTags(asked)).toEqual(both([settle.state, 'ApprovalRequested']))

      const replayed = applyEvent(asked, event)

      expect(replayed.projection.chatMessages).toEqual(asked.projection.chatMessages)
      expect(replayed.chat.chatMessages).toEqual(asked.chat.chatMessages)
    }
  )

  // A stale answer: the part with its call id holds another request, and no part holds its own
  // (its request's part was never seen, for example after hydration). It answers nothing, as in
  // `reduceAgentEvents`, instead of answering the pending approval.
  const staleCases = [question(), input(), interaction()].flatMap(kind =>
    kind.settles
      .filter(settle => settle.state !== 'Completed')
      .flatMap(settle =>
        settle
          .events(step => `run:${step}`)
          .flatMap(answerReplay)
          .map(event => ({ title: `${kind.name} ${settle.name}: ${event._tag}`, event }))
      )
  )

  it.each(staleCases)(
    'drops an answer whose request no part holds when the part holds another ($title)',
    ({ event }) => {
      const later = reused(approval(), { env: 'staging' })

      const asked = applyEvents(initialChats, [
        LLMStreamStart.make({ eventId: 'run:start-1', turn: 1 }),
        AssistantMessageEvent.make({ eventId: 'run:message-1', message: ask(later.call) }),
        later.requested('run:request'),
        awaiting(later.request, 'run:pause')
      ])

      expect(stateTags(asked)).toEqual(both(['ApprovalRequested']))

      const answered = applyEvent(asked, event)

      expect(answered.projection.chatMessages).toEqual(asked.projection.chatMessages)
      expect(answered.chat.chatMessages).toEqual(asked.chat.chatMessages)
      expect(answered.chat.status).toEqual(asked.chat.status)
    }
  )

  it("replaces the later turn's pending request with a newer one of its own call", () => {
    const kind = approval()
    const settle = kind.settles[1]
    const later = reused(kind)

    if (settle === undefined || !Predicate.isTagged(later.request, 'ToolApprovalRequest')) {
      throw new Error('expected an approval')
    }

    const previewed = ToolApprovalRequest.make({
      ...later.request,
      previewError: { cause: 'timeout', message: 'The preview timed out.' }
    })

    const chats = applyEvents(askedLater(kind, settle, later), [
      ToolApprovalRequested.make({ call: later.call, request: previewed }),
      awaiting(previewed)
    ])

    expect(toolStates(chats.projection.chatMessages)).toMatchObject([
      { _tag: 'Completed' },
      { _tag: 'ApprovalRequested', request: previewed }
    ])

    expect(chats.chat.chatMessages).toEqual(chats.projection.chatMessages)
    expect(chats.chat.status).toMatchObject({ _tag: 'Blocked', requests: [previewed] })
  })

  it.each(['request event', 'pause'] as const)(
    'lets a request for a call no part holds act on the later turn (%s)',
    replay => {
      // No earlier part holds the request's exact call: it is the latest turn's call, as before.
      const kind = approval()
      const settle = kind.settles[1]

      if (settle === undefined) throw new Error('expected a settle')

      const unseen = reused(kind, { env: 'dev' })
      const asked = askedLater(kind, settle, reused(kind))

      const replayed = applyEvent(
        asked,
        replay === 'request event' ? unseen.requested() : awaiting(unseen.request)
      )

      const expected = [
        { _tag: 'ToolCall', state: { _tag: 'Completed' } },
        { _tag: 'ToolCall', call: unseen.call, state: { _tag: 'ApprovalRequested' } }
      ]

      const parts = (messages: ReadonlyArray<AgentChatMessage>) =>
        messages.flatMap(message =>
          message.parts.filter(part => Predicate.isTagged(part, 'ToolCall'))
        )

      expect(parts(replayed.projection.chatMessages)).toMatchObject(expected)
      expect(parts(replayed.chat.chatMessages)).toMatchObject(expected)
    }
  )
})

describe('an invalid input answer', () => {
  // The loop's own events: an invalid payload re-pends the same request without `InputSubmitted`.
  const NotEvil = Schema.String.pipe(
    Schema.refine((value): value is string => value !== 'evil', { identifier: 'NotEvil' })
  )

  const word: InputToolHandler = {
    validateCall: params =>
      Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Never))(params),
    validateResponse: data => Schema.decodeUnknownEffect(NotEvil)(data).pipe(Effect.asVoid),
    formatContent: ({ data }) => `Word: ${JSON.stringify(data)}`
  }

  const wordDef = makeInputToolDef({
    name: 'word',
    description: 'Collect a word.',
    renderer: 'text-field',
    title: 'Word'
  })

  const call = ToolCall.make({ id: toolCallId, name: 'word', params: {} })

  const answer = (data: string) =>
    InputResponse.make({
      requestId: `input:word:${toolCallId}`,
      toolCallId,
      outcome: 'submitted',
      source: 'user',
      data
    })

  const batch = (responses: ReadonlyArray<HitlResponse>) =>
    runToolBatch({
      tools: [wordDef],
      inputs: { word },
      calls: [call],
      hitlResponses: responses
    }).pipe(
      Stream.runCollect,
      Effect.map(chunk => Array.from(chunk)),
      Effect.provide(Layer.mergeAll(LoopConfig.defaultLayer, TestToolExecutor.layer({})))
    )

  it.effect('re-pends the input, and a replayed request leaves the corrected answer settled', () =>
    Effect.gen(function* () {
      const asked = yield* batch([])
      const invalid = yield* batch([answer('evil')])
      const corrected = yield* batch([answer('kind')])

      expect(invalid.map(event => event._tag)).toEqual(['InputRequested', 'AgentAwaitingInput'])

      const paused = applyEvents(initialChats, [
        LLMStreamStart.make({ eventId: 'run:start-1', turn: 1 }),
        AssistantMessageEvent.make({ eventId: 'run:message-1', message: ask(call) }),
        ...asked
      ])

      expect(stateTags(paused)).toEqual(both(['InputRequested']))

      const repended = applyEvents(submit(paused, answer('evil')), invalid)

      expect(stateTags(repended)).toEqual(both(['InputRequested']))

      const settled = applyEvents(submit(repended, answer('kind')), corrected)

      expect(stateTags(settled)).toEqual(both(['Completed']))

      // The first request again, without event id, after the corrected answer completed the call.
      const replayed = applyEvents(
        settled,
        asked.filter(event => Predicate.isTagged(event, 'InputRequested'))
      )

      expect(replayed.projection.chatMessages).toEqual(settled.projection.chatMessages)
      expect(replayed.chat.chatMessages).toEqual(settled.chat.chatMessages)
    })
  )
})

describe('a call the run stopped while it ran', () => {
  // A running call has no result: after an abort, the next run resumes it and asks again.
  const kind = approval()

  const gated = ToolDef.make({
    name: kind.call.name,
    description: 'Deploy.',
    parameters: {},
    approval: ToolApprovalPolicy.make({ mode: 'manual' })
  })

  const goOn = UserMessage.make({ content: 'Go on' })

  const approved = ToolApprovalResponse.make({
    requestId: kind.request.requestId,
    toolCallId,
    decision: 'approved',
    source: 'user'
  })

  it.effect('shows the approval card again and waits for it', () =>
    Effect.gen(function* () {
      // The loop's own events for the next run: the transcript holds the call without a result.
      const resumed = yield* run({
        messages: [UserMessage.make({ content: 'Deploy' }), ask(kind.call), goOn],
        systemPrompt: 'Deploy.',
        tools: [gated],
        model: 'faux',
        resume: true
      }).pipe(
        Stream.runCollect,
        Effect.map(chunk => Array.from(chunk)),
        Effect.provide(
          Layer.mergeAll(
            ContextTransformer.identity,
            LoopConfig.defaultLayer,
            FauxProvider.layer(),
            TestToolExecutor.layer({})
          )
        )
      )

      expect(resumed.map(event => event._tag)).toEqual([
        'AgentStart',
        'ToolApprovalRequested',
        'AgentAwaitingInput'
      ])

      const paused = applyEvents(initialChats, [
        LLMStreamStart.make({ eventId: 'run:start-1', turn: 1 }),
        AssistantMessageEvent.make({ eventId: 'run:message-1', message: ask(kind.call) }),
        kind.requested('run:request'),
        awaiting(kind.request, 'run:pause')
      ])

      const running = applyEvents(submit(paused, approved), [
        ToolApprovalGranted.make({ eventId: 'run:granted', toolCallId, response: approved }),
        ToolExecutionStarted.make({ eventId: 'run:started', call: kind.call })
      ])

      expect(stateTags(running)).toEqual(both(['Running']))

      const stopped = reduceAgentChatState(running.chat, AgentChatAction.Abort())

      const next: Chats = {
        ...running,
        chat: reduceAgentChatState(stopped, AgentChatAction.Submit({ message: goOn }))
      }

      const asked = applyEvents(next, resumed)

      expect(stateTags(asked)).toEqual(both(['ApprovalRequested']))
      expect(asked.chat.status).toMatchObject({ _tag: 'Blocked', kind: 'permission' })
    })
  )
})

describe('the request an answer reaches', () => {
  // The chat reads a part's request as the client does: an answered or cancelled part by its
  // response, a denial by the approval it denies; a part with its result is never the one an answer
  // replays. A replayed earlier turn's answer then reaches its own part, and a stale one nothing.
  const asked = question()
  const answeredSettle = asked.settles[0]

  if (answeredSettle === undefined) throw new Error('expected an answered settle')

  const answeredQ1 = answeredSettle
    .events(step => `run:${step}`)
    .flatMap(answerReplay)
    .at(0)

  if (answeredQ1 === undefined) throw new Error('expected an answer')

  /** Turn 1 answered its question; turn 3 reuses `call_0` for `events`. */
  const afterTurnOne = (events: ReadonlyArray<AgentEvent>) =>
    applyEvents(settledChats(asked, answeredSettle, 'after the next turn started'), [
      LLMStreamStart.make({ eventId: 'run:start-3', turn: 3 }),
      ...events
    ])

  /** Only turn 3: no part holds turn 1's request, so its answer is stale. */
  const alone = (events: ReadonlyArray<AgentEvent>) =>
    applyEvents(initialChats, [LLMStreamStart.make({ eventId: 'run:start-3', turn: 3 }), ...events])

  const expectUnchanged = (chats: Chats, event: AgentEvent) => {
    const replayed = applyEvent(chats, event)

    expect(replayed.projection.chatMessages).toEqual(chats.projection.chatMessages)
    expect(replayed.chat.chatMessages).toEqual(chats.chat.chatMessages)
    expect(replayed.chat.status).toEqual(chats.chat.status)
  }

  const deploy = reused(approval(), { env: 'staging' })

  const denied: ReadonlyArray<AgentEvent> = [
    AssistantMessageEvent.make({ eventId: 'run:message-3', message: ask(deploy.call) }),
    deploy.requested('run:request-3'),
    awaiting(deploy.request, 'run:pause-3'),
    ToolApprovalDenied.make({
      eventId: 'run:denied-3',
      toolCallId,
      reason: 'Not now',
      response: ToolApprovalResponse.make({
        requestId: deploy.request.requestId,
        toolCallId,
        decision: 'denied',
        source: 'user'
      })
    })
  ]

  it('keeps the approval a denial denies, and a later denied card for an earlier answer', () => {
    const chats = afterTurnOne(denied)

    expect(toolStates(chats.projection.chatMessages)).toMatchObject([
      { _tag: 'QuestionAnswered' },
      { _tag: 'Denied', request: deploy.request }
    ])

    expectUnchanged(chats, answeredQ1)
    expectUnchanged(alone(denied), answeredQ1)
  })

  // An input answered on its `Called` part keeps only its response.
  const word = input()

  const submittedWithoutRequest: ReadonlyArray<AgentEvent> = [
    AssistantMessageEvent.make({ eventId: 'run:message-3', message: ask(word.call) }),
    InputSubmitted.make({
      eventId: 'run:submitted-3',
      response: InputResponse.make({
        requestId: word.request.requestId,
        toolCallId,
        outcome: 'submitted',
        source: 'user',
        data: 'kind'
      })
    })
  ]

  const staleInteraction = InteractionSubmitted.make({
    response: InteractionResponse.make({
      requestId: interactionRequestId(interaction().call),
      toolCallId,
      outcome: 'submitted',
      source: 'user',
      actionId: 'publish',
      data: {}
    })
  })

  it('reads an answered part without its request by its response', () => {
    const chats = afterTurnOne(submittedWithoutRequest)
    const states = toolStates(chats.projection.chatMessages)

    expect(states).toMatchObject([{ _tag: 'QuestionAnswered' }, { _tag: 'InputSubmitted' }])
    expect(states.at(-1)).not.toHaveProperty('request')

    // The replayed earlier answer gives way to turn 1's part; a stale one changes nothing.
    expectUnchanged(chats, answeredQ1)
    expectUnchanged(chats, staleInteraction)
  })

  it('reads a snapshot part holding only its response by its response', () => {
    const messages = buildAgentChatMessages({
      messages: [UserMessage.make({ content: 'A word?' }), ask(word.call)],
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: [
        AgentToolRun.InputSubmitted({
          response: InputResponse.make({
            requestId: word.request.requestId,
            toolCallId,
            outcome: 'submitted',
            source: 'user',
            data: 'kind'
          })
        })
      ],
      error: null
    })

    const chats: Chats = {
      projection: makeAgentChatEventProjectionState(messages),
      chat: { ...initialAgentChatState, chatMessages: messages }
    }

    expect(toolStates(messages)).toMatchObject([{ _tag: 'InputSubmitted' }])

    expectUnchanged(chats, staleInteraction)
  })

  const export_ = ToolCall.make({ id: toolCallId, name: 'export', params: { format: 'csv' } })
  const search = ToolCall.make({ id: toolCallId, name: 'web_search', params: { q: 'Oslo' } })

  const finished: ReadonlyArray<{
    readonly state: ChatToolState['_tag']
    readonly events: ReadonlyArray<AgentEvent>
  }> = [
    {
      state: 'Completed',
      events: [
        AssistantMessageEvent.make({ eventId: 'run:message-3', message: ask(deploy.call) }),
        ...ran(deploy.call, step => `run:${step}-3`)
      ]
    },
    {
      state: 'Accepted',
      events: [
        AssistantMessageEvent.make({ eventId: 'run:message-3', message: ask(export_) }),
        ToolExecutionStarted.make({ eventId: 'run:started-3', call: export_ }),
        ToolExecutionAccepted.make({
          eventId: 'run:accepted-3',
          call: export_,
          result: makeBackgroundToolAcceptedResult({
            toolCallId,
            acceptance: BackgroundToolAccepted.make({ version: 1, executionId: 'owner:export' })
          })
        })
      ]
    },
    {
      state: 'Errored',
      events: [
        AssistantMessageEvent.make({ eventId: 'run:message-3', message: ask(deploy.call) }),
        ToolExecutionStarted.make({ eventId: 'run:started-3', call: deploy.call }),
        ToolExecutionError.make({
          eventId: 'run:error-3',
          call: deploy.call,
          message: 'Deploy failed',
          code: 'tool_error'
        })
      ]
    },
    {
      state: 'ProviderCompleted',
      events: [
        ProviderToolResult.make({
          eventId: 'run:provider-3',
          call: search,
          result: ToolResult.make({ toolCallId, content: 'Oslo' })
        })
      ]
    }
  ]

  it.each(finished)(
    'leaves the $state part alone for a replayed or stale answer',
    ({ state, events }) => {
      const chats = afterTurnOne(events)

      expect(stateTags(chats)).toEqual(both(['QuestionAnswered', state]))

      expectUnchanged(chats, answeredQ1)
      expectUnchanged(alone(events), answeredQ1)
    }
  )

  it('still answers a running part (an answer can precede its request there)', () => {
    const chats = applyEvents(initialChats, [
      LLMStreamStart.make({ eventId: 'run:start-1', turn: 1 }),
      AssistantMessageEvent.make({ eventId: 'run:message-1', message: ask(asked.call) }),
      ToolExecutionStarted.make({ eventId: 'run:started', call: asked.call }),
      answeredQ1
    ])

    expect(stateTags(chats)).toEqual(both(['QuestionAnswered']))
  })

  describe('a replayed denial', () => {
    // A denial answers only a pending approval, and the loop asks only before a result: turn 1's
    // denial replayed without event id leaves a later turn's question or finished call alone.
    const deployKind = approval()
    const deniedSettle = deployKind.settles[0]

    if (deniedSettle === undefined) throw new Error('expected a denied settle')

    const denial = (requestId: string) =>
      ToolApprovalDenied.make({
        toolCallId,
        reason: 'Not now',
        response: ToolApprovalResponse.make({
          requestId,
          toolCallId,
          decision: 'denied',
          source: 'user'
        })
      })

    const replayedDenial = denial(deployKind.request.requestId)

    const afterDenial = (events: ReadonlyArray<AgentEvent>) =>
      applyEvents(settledChats(deployKind, deniedSettle, 'after the next turn started'), [
        LLMStreamStart.make({ eventId: 'run:start-3', turn: 3 }),
        ...events
      ])

    const city = reused(question(), { topic: 'city' })

    const later: ReadonlyArray<{
      readonly state: ChatToolState['_tag']
      readonly events: ReadonlyArray<AgentEvent>
    }> = [
      {
        state: 'QuestionRequested',
        events: [
          AssistantMessageEvent.make({ eventId: 'run:message-3', message: ask(city.call) }),
          city.requested('run:request-3'),
          awaiting(city.request, 'run:pause-3')
        ]
      },
      ...finished.filter(({ state }) => state === 'Completed' || state === 'Accepted')
    ]

    it.each(later)("leaves the later turn's $state part alone", ({ state, events }) => {
      const chats = afterDenial(events)

      expect(stateTags(chats)).toEqual(both(['Denied', state]))

      expectUnchanged(chats, replayedDenial)
      expectUnchanged(alone(events), replayedDenial)
    })

    it("still denies the later turn's pending approval", () => {
      const chats = afterDenial([
        AssistantMessageEvent.make({ eventId: 'run:message-3', message: ask(deploy.call) }),
        deploy.requested('run:request-3'),
        awaiting(deploy.request, 'run:pause-3'),
        denial(deploy.request.requestId)
      ])

      expect(toolStates(chats.projection.chatMessages)).toMatchObject([
        { _tag: 'Denied' },
        { _tag: 'Denied', request: deploy.request }
      ])

      expect(chats.chat.chatMessages).toEqual(chats.projection.chatMessages)
    })

    it('still denies a running part (it holds no request)', () => {
      const chats = applyEvents(initialChats, [
        LLMStreamStart.make({ eventId: 'run:start-1', turn: 1 }),
        AssistantMessageEvent.make({ eventId: 'run:message-1', message: ask(deployKind.call) }),
        ToolExecutionStarted.make({ eventId: 'run:started', call: deployKind.call }),
        replayedDenial
      ])

      expect(stateTags(chats)).toEqual(both(['Denied']))
    })
  })

  describe('applyAgentEventToChatMessages', () => {
    // No turn start: the last message holding the call. A stale answer still changes nothing.
    const fold = (events: ReadonlyArray<AgentEvent>) =>
      events.reduce<ReadonlyArray<AgentChatMessage>>(
        (messages, event) => applyAgentEventToChatMessages(messages, event),
        []
      )

    it.each([
      { state: 'ApprovalRequested', events: denied.slice(0, 3) },
      { state: 'Denied', events: denied },
      ...finished.map(({ state, events }) => ({ state, events }))
    ])('drops a stale answer reaching the $state part', ({ state, events }) => {
      const messages = fold(events)

      expect(toolStates(messages).map(current => current._tag)).toEqual([state])
      expect(applyAgentEventToChatMessages(messages, answeredQ1)).toEqual(messages)
    })
  })
})
