import { Effect, Layer, Predicate, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentAwaitingInput,
  AssistantAgentMessage,
  AssistantMessageEvent,
  AssistantTextPart,
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
  ToolExecutionCompleted,
  ToolExecutionError,
  ToolExecutionStarted,
  ToolResult,
  UserMessage,
  interactionRequestId,
  zeroAgentUsage,
  type AgentEvent,
  type HitlRequest,
  type HitlResponse,
  type InputToolHandler
} from '@yolk-sdk/agent/protocol'
import { ContextTransformer, LoopConfig, run, runToolBatch } from '../../src/loop/index.ts'
import { FauxProvider, TestToolExecutor } from '../../src/loop/testing/index.ts'
import { AgentChatAction } from '../../src/react/chat-actions.ts'
import {
  applyAgentEventToChatProjection,
  initialAgentChatState,
  makeAgentChatEventProjectionState,
  reduceAgentChatState,
  type AgentChatEventProjectionState,
  type AgentChatState
} from '../../src/react/chat-core.ts'
import type { AgentChatMessage, ChatToolState } from '../../src/react/chat-messages.ts'
import { makeInputToolDef } from '../../src/tools/index.ts'

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
