import { Effect, Layer, Option, Predicate, Stream } from 'effect'
import { describe, expect, expectTypeOf, it } from '@effect/vitest'
import {
  AgentAwaitingInput,
  AssistantAgentMessage,
  AssistantMessageEvent,
  AssistantTextPart,
  BackgroundToolAccepted,
  HostToolCallPart,
  LLMStreamStart,
  QuestionAnswer,
  QuestionPrompt,
  QuestionRequest,
  QuestionRequested,
  QuestionResponse,
  ToolApprovalPolicy,
  ToolApprovalRequest,
  ToolApprovalRequested,
  ToolApprovalResponse,
  ToolCall,
  ToolDef,
  ToolExecutionAccepted,
  ToolExecutionCompleted,
  ToolExecutionStarted,
  ToolInputEnd,
  ToolResult,
  ToolResultMessage,
  UserMessage,
  makeBackgroundToolAcceptedResult,
  zeroAgentUsage,
  type AgentEvent,
  type AgentMessage,
  type HitlRequest,
  type HitlResponse
} from '@yolk-sdk/agent/protocol'
import {
  initialAgentClientState,
  markAgentAborted,
  markAgentRunStart,
  reduceAgentEvents,
  submitAgentUserMessage,
  type AgentClientModelTurnStart,
  type AgentClientState,
  type AgentClientTurnStart
} from '../../src/client'
import { AgentToolRun } from '../../src/client/state.ts'
import { ContextTransformer, LoopConfig, run } from '../../src/loop/index.ts'
import { FauxProvider, Reply, TestToolExecutor } from '../../src/loop/testing/index.ts'
import { AgentChatAction } from '../../src/react/chat-actions.ts'
import {
  applyAgentEventToChatProjection,
  initialAgentChatState,
  makeAgentChatEventProjectionState,
  markChatRunStart,
  reduceAgentChatState,
  type AgentChatEventProjectionState,
  type AgentChatState,
  type AgentChatTurnStart
} from '../../src/react/chat-core.ts'
import { buildAgentChatMessages, type AgentChatMessage } from '../../src/react/chat-messages.ts'
import { makeQuestionToolDef } from '../../src/tools/index.ts'

// A loop resume emits `AgentStart`, then the resumed tool batch (answers, starts, results), before
// its first model turn. Providers reuse `call_0` in every turn: the batch acts on the paused call,
// never on an earlier turn's call that reused the id. Every scenario resumes through the real
// loop and runs through the client state, the chat projection and the `useAgentChat` reducer.

type Reducers = {
  readonly client: AgentClientState
  readonly projection: AgentChatEventProjectionState
  readonly chat: AgentChatState
}

const initial: Reducers = {
  client: initialAgentClientState,
  projection: makeAgentChatEventProjectionState(),
  chat: initialAgentChatState
}

const applyEvents = (reducers: Reducers, events: ReadonlyArray<AgentEvent>): Reducers => ({
  client: reduceAgentEvents(events, reducers.client),
  projection: events.reduce(
    (projection, event) => applyAgentEventToChatProjection(projection, event),
    reducers.projection
  ),
  chat: events.reduce(
    (chat, event) => reduceAgentChatState(chat, AgentChatAction.Event({ event })),
    reducers.chat
  )
})

/** A call as `name params:state`. */
const describeCall = (call: ToolCall, state: string) =>
  `${call.name} ${JSON.stringify(call.params)}:${state}`

const describeRun = (run: AgentToolRun) => {
  if ('call' in run) return describeCall(run.call, run._tag)

  if ('request' in run && run.request !== undefined) return describeCall(run.request.call, run._tag)

  return run._tag
}

const chatCalls = (messages: ReadonlyArray<AgentChatMessage>) =>
  messages.flatMap(message =>
    message.parts.flatMap(part =>
      Predicate.isTagged(part, 'ToolCall') ? [describeCall(part.call, part.state._tag)] : []
    )
  )

const calls = (reducers: Reducers) => ({
  client: reducers.client.toolRuns.map(describeRun),
  projection: chatCalls(reducers.projection.chatMessages),
  chat: chatCalls(reducers.chat.chatMessages)
})

const all = <Value>(value: Value) => ({ client: value, projection: value, chat: value })

let sequence = 0

const host = () => ({ eventId: `run-1:${(sequence += 1)}`, streamId: 'run-1' })

const answer = (content: string, toolCalls: ReadonlyArray<ToolCall> = []) =>
  AssistantAgentMessage.make({
    parts: [
      AssistantTextPart.make({ content }),
      ...toolCalls.map(call => HostToolCallPart.make({ call }))
    ]
  })

/** One model turn: its start, the call's input and its `AssistantMessage`. */
const modelTurn = (turn: number, message: AssistantAgentMessage, call?: ToolCall) => [
  LLMStreamStart.make({ ...host(), turn }),
  ...(call === undefined ? [] : [ToolInputEnd.make({ ...host(), call })]),
  AssistantMessageEvent.make({ ...host(), message })
]

const weather = (city: string) => ToolCall.make({ id: 'call_0', name: 'weather', params: { city } })

const oslo = weather('Oslo')

const bergen = weather('Bergen')

const weatherDef = ToolDef.make({
  name: 'weather',
  description: 'Weather.',
  parameters: { type: 'object', properties: { city: { type: 'string' } } }
})

const gatedWeatherDef = ToolDef.make({
  name: 'weather',
  description: 'Weather.',
  parameters: { type: 'object', properties: { city: { type: 'string' } } },
  approval: ToolApprovalPolicy.make({ mode: 'manual' })
})

const turnOne = answer('Oslo first', [oslo])

const osloResult = ToolResultMessage.make({ toolCallId: 'call_0', content: '12C' })

const turnTwo = answer('Now Bergen', [bergen])

const done = 'Bergen is 9C'

/** The real loop resuming a transcript whose last assistant message has calls without results. */
const resume = (input: {
  readonly messages: ReadonlyArray<AgentMessage>
  readonly tools: ReadonlyArray<ToolDef>
  readonly hitlResponses?: ReadonlyArray<HitlResponse>
  readonly awaitingRequests?: ReadonlyArray<HitlRequest>
}) =>
  run({
    messages: input.messages,
    systemPrompt: 'Weather.',
    tools: input.tools,
    model: 'faux',
    resume: true,
    hitlResponses: input.hitlResponses,
    awaitingRequests: input.awaitingRequests
  }).pipe(
    Stream.runCollect,
    Effect.map(chunk => Array.from(chunk)),
    Effect.provide(
      Layer.mergeAll(
        ContextTransformer.identity,
        LoopConfig.defaultLayer,
        FauxProvider.layer(Reply.text(done)),
        TestToolExecutor.layer({ weather: '9C', export: 'exported' })
      )
    )
  )

const tags = (events: ReadonlyArray<AgentEvent>) => events.map(event => event._tag)

describe('a loop resume after a pause', () => {
  it.effect("acts on the paused call, not an earlier turn's accepted background call", () =>
    Effect.gen(function* () {
      const exporting = ToolCall.make({ id: 'call_0', name: 'export', params: { format: 'csv' } })

      const accepted = makeBackgroundToolAcceptedResult({
        toolCallId: exporting.id,
        acceptance: BackgroundToolAccepted.make({ version: 1, executionId: 'owner:export' })
      })

      const acknowledged = ToolResultMessage.make({
        toolCallId: exporting.id,
        content: accepted.content,
        acceptance: accepted.acceptance
      })

      const startedExport = answer('Starting the export', [exporting])

      const approval = ToolApprovalRequest.make({
        requestId: 'approval:call_0',
        toolCallId: 'call_0',
        call: bergen
      })

      // `tool-run-turns.test.ts`'s pause: turn 1 handed `call_0` to a background owner, turn 2
      // reused the id for a call waiting on its approval.
      const paused = applyEvents(initial, [
        ...modelTurn(1, startedExport, exporting),
        ToolExecutionStarted.make({ ...host(), call: exporting }),
        ToolExecutionAccepted.make({ ...host(), call: exporting, result: accepted }),
        ...modelTurn(2, turnTwo, bergen),
        ToolApprovalRequested.make({ ...host(), call: bergen, request: approval }),
        AgentAwaitingInput.make({
          ...host(),
          requests: [approval],
          messages: [startedExport, acknowledged, turnTwo],
          turns: 2,
          usage: zeroAgentUsage
        })
      ])

      expect(calls(paused)).toEqual({
        client: ['export {"format":"csv"}:Accepted', 'weather {"city":"Bergen"}:ApprovalRequested'],
        projection: [
          'export {"format":"csv"}:Accepted',
          'weather {"city":"Bergen"}:ApprovalRequested'
        ],
        chat: ['export {"format":"csv"}:Accepted', 'weather {"city":"Bergen"}:ApprovalRequested']
      })

      const resumed = yield* resume({
        messages: [
          UserMessage.make({ content: 'Export, then Bergen' }),
          startedExport,
          acknowledged,
          turnTwo
        ],
        tools: [gatedWeatherDef],
        hitlResponses: [
          ToolApprovalResponse.make({
            requestId: approval.requestId,
            toolCallId: 'call_0',
            decision: 'approved',
            source: 'user'
          })
        ],
        awaitingRequests: [approval]
      })

      expect(tags(resumed).slice(0, 4)).toEqual([
        'AgentStart',
        'ToolApprovalGranted',
        'ToolExecutionStarted',
        'ToolExecutionCompleted'
      ])

      const ended = applyEvents(paused, resumed)

      expect(calls(ended)).toEqual(
        all(['export {"format":"csv"}:Accepted', 'weather {"city":"Bergen"}:Completed'])
      )

      expect(ended.client.status._tag).toBe('Done')
      expect(ended.chat.status._tag).toBe('Done')
    })
  )

  it.effect("acts on the paused question, not an earlier turn's completed call", () =>
    Effect.gen(function* () {
      const prompts = [
        QuestionPrompt.make({ id: 'unit', prompt: 'Celsius or Fahrenheit?' })
      ] as const

      const unit = ToolCall.make({ id: 'call_0', name: 'question', params: { questions: prompts } })

      const asking = answer('Which unit?', [unit])

      const question = QuestionRequest.make({
        requestId: 'question:call_0',
        toolCallId: 'call_0',
        call: unit,
        questions: prompts
      })

      const paused = applyEvents(initial, [
        ...modelTurn(1, turnOne, oslo),
        ToolExecutionStarted.make({ ...host(), call: oslo }),
        ToolExecutionCompleted.make({
          ...host(),
          call: oslo,
          result: ToolResult.make({ toolCallId: 'call_0', content: '12C' })
        }),
        ...modelTurn(2, asking, unit),
        QuestionRequested.make({ ...host(), request: question }),
        AgentAwaitingInput.make({
          ...host(),
          requests: [question],
          messages: [turnOne, osloResult, asking],
          turns: 2,
          usage: zeroAgentUsage
        })
      ])

      const resumed = yield* resume({
        messages: [UserMessage.make({ content: 'Weather?' }), turnOne, osloResult, asking],
        tools: [weatherDef, makeQuestionToolDef()],
        hitlResponses: [
          QuestionResponse.make({
            requestId: question.requestId,
            toolCallId: 'call_0',
            outcome: 'answered',
            source: 'user',
            answers: [QuestionAnswer.make({ questionId: 'unit', customAnswer: 'Celsius' })]
          })
        ],
        awaitingRequests: [question]
      })

      const batch = resumed.slice(0, 3)

      expect(tags(batch)).toEqual(['AgentStart', 'QuestionAnswered', 'ToolExecutionCompleted'])

      // The answer reaches no run (the client dropped the pending question at `AgentStart`): it
      // adds one, leaving the earlier turn's call.
      expect(calls(applyEvents(paused, batch.slice(0, 2))).client).toEqual([
        'weather {"city":"Oslo"}:Completed',
        'QuestionAnswered'
      ])

      const ended = applyEvents(paused, resumed)

      const expected = [
        'weather {"city":"Oslo"}:Completed',
        `question ${JSON.stringify(unit.params)}:Completed`
      ]

      expect(calls(ended)).toEqual(all(expected))
    })
  )
})

describe('a loop resume of a call the client never saw', () => {
  // A host that streams without `AgentStart` relies on the local submit's run start.
  it.effect.each(['with AgentStart', 'without AgentStart'] as const)(
    "adds the resumed call, leaving an earlier turn's call with its id (%s)",
    start =>
      Effect.gen(function* () {
        // The person stopped the run while turn 2 streamed; the host committed turn 2 (`call_0`
        // reused for Bergen) without the client seeing it. "Go on" resumes the call.
        const stopped = applyEvents(initial, [
          ...modelTurn(1, turnOne, oslo),
          ToolExecutionStarted.make({ ...host(), call: oslo }),
          ToolExecutionCompleted.make({
            ...host(),
            call: oslo,
            result: ToolResult.make({ toolCallId: 'call_0', content: '12C' })
          }),
          LLMStreamStart.make({ ...host(), turn: 2 })
        ])

        const goOn = UserMessage.make({ content: 'Go on' })

        const submitted: Reducers = {
          client: submitAgentUserMessage(markAgentAborted(stopped.client), goOn),
          projection: stopped.projection,
          chat: reduceAgentChatState(
            reduceAgentChatState(stopped.chat, AgentChatAction.Abort()),
            AgentChatAction.Submit({ message: goOn })
          )
        }

        const resumed = yield* resume({
          messages: [UserMessage.make({ content: 'Weather?' }), turnOne, osloResult, turnTwo, goOn],
          tools: [weatherDef]
        })

        expect(tags(resumed).slice(0, 3)).toEqual([
          'AgentStart',
          'ToolExecutionStarted',
          'ToolExecutionCompleted'
        ])

        const streamed =
          start === 'with AgentStart'
            ? resumed
            : resumed.filter(event => !Predicate.isTagged(event, 'AgentStart'))

        const ended = applyEvents(submitted, streamed)

        expect(calls(ended)).toEqual(
          all(['weather {"city":"Oslo"}:Completed', 'weather {"city":"Bergen"}:Completed'])
        )
      })
  )
})

describe('a host that rebuilds its state from a snapshot (#355)', () => {
  // A snapshot host (o-o) rebuilds chat and client state from stored messages and runs, then
  // streams the run from the snapshot's cursor: a resumed run's `AgentStart` may lie before it.
  // `markChatRunStart` and `markAgentRunStart` give the rebuilt state the run start `AgentStart`
  // would have set.
  type Snapshot = {
    readonly messages: ReadonlyArray<AgentMessage>
    readonly toolRuns: ReadonlyArray<AgentToolRun>
  }

  const fromSnapshot = (snapshot: Snapshot, runStart: boolean): Reducers => {
    const chatMessages = buildAgentChatMessages({
      messages: snapshot.messages,
      userDraft: '',
      assistantDraft: '',
      reasoningDraft: '',
      toolRuns: snapshot.toolRuns,
      error: null
    })

    const rebuilt: Reducers = {
      client: {
        ...initialAgentClientState,
        messages: snapshot.messages,
        toolRuns: snapshot.toolRuns
      },
      projection: makeAgentChatEventProjectionState(chatMessages),
      chat: { ...initialAgentChatState, chatMessages }
    }

    return runStart
      ? {
          client: markAgentRunStart(rebuilt.client),
          projection: markChatRunStart(rebuilt.projection),
          chat: markChatRunStart(rebuilt.chat)
        }
      : rebuilt
  }

  const user = UserMessage.make({ content: 'Weather in Oslo, then Bergen?' })

  /** The earlier turn's run, which the host keeps beside the snapshot's messages. */
  const osloRun = AgentToolRun.Completed({
    call: oslo,
    result: ToolResult.make({ toolCallId: 'call_0', content: '12C' }),
    startedAtMs: 0,
    endedAtMs: 0
  })

  const ended = ['weather {"city":"Oslo"}:Completed', 'weather {"city":"Bergen"}:Completed']

  /** The resumed run's events from the snapshot's cursor: its `AgentStart` lies before it. */
  const afterCursor = (events: ReadonlyArray<AgentEvent>) =>
    events.filter(event => !Predicate.isTagged(event, 'AgentStart'))

  it.effect("keeps a resumed approval's batch off an earlier turn's run", () =>
    Effect.gen(function* () {
      const approval = ToolApprovalRequest.make({
        requestId: 'approval:call_0',
        toolCallId: 'call_0',
        call: bergen
      })

      // The person approved; the reconciled snapshot no longer holds the request as pending.
      const snapshot: Snapshot = {
        messages: [user, turnOne, osloResult, turnTwo],
        toolRuns: [osloRun]
      }

      const resumed = yield* resume({
        messages: [user, turnOne, osloResult, turnTwo],
        tools: [gatedWeatherDef],
        hitlResponses: [
          ToolApprovalResponse.make({
            requestId: approval.requestId,
            toolCallId: 'call_0',
            decision: 'approved',
            source: 'user'
          })
        ],
        awaitingRequests: [approval]
      })

      expect(tags(resumed).slice(0, 4)).toEqual([
        'AgentStart',
        'ToolApprovalGranted',
        'ToolExecutionStarted',
        'ToolExecutionCompleted'
      ])

      expect(calls(applyEvents(fromSnapshot(snapshot, true), afterCursor(resumed)))).toEqual(
        all(ended)
      )

      // Without the run start, the client's batch replaced the earlier turn's run.
      expect(
        calls(applyEvents(fromSnapshot(snapshot, false), afterCursor(resumed))).client
      ).toEqual(['weather {"city":"Bergen"}:Completed'])
    })
  )

  it.effect(
    "adds a resumed call the snapshot's messages lack, leaving an earlier turn's call",
    () =>
      Effect.gen(function* () {
        // The host stored the run's messages before turn 2 (`call_0` reused for Bergen) committed;
        // the stopped batch resumes it.
        const snapshot: Snapshot = { messages: [user, turnOne, osloResult], toolRuns: [osloRun] }

        const resumed = yield* resume({
          messages: [user, turnOne, osloResult, turnTwo],
          tools: [weatherDef]
        })

        expect(tags(resumed).slice(0, 3)).toEqual([
          'AgentStart',
          'ToolExecutionStarted',
          'ToolExecutionCompleted'
        ])

        expect(calls(applyEvents(fromSnapshot(snapshot, true), afterCursor(resumed)))).toEqual(
          all(ended)
        )
      })
  )

  it('types the marked state with its run start, not a narrower start the input had', () => {
    const modelStart: AgentChatTurnStart & { readonly run?: undefined } = {
      streamId: 'run-1',
      turn: 2,
      after: Option.none()
    }

    const marked = markChatRunStart({
      ...makeAgentChatEventProjectionState(),
      turnStart: modelStart
    })

    expectTypeOf(marked.turnStart).toEqualTypeOf<AgentChatTurnStart>()
    expect(marked.turnStart).toEqual({ streamId: '', turn: 0, after: Option.none(), run: true })

    const clientStart: AgentClientModelTurnStart = { streamId: 'run-1', turn: 2, firstRun: 0 }
    const client = markAgentRunStart({ ...initialAgentClientState, turnStart: clientStart })

    expectTypeOf(client.turnStart).toEqualTypeOf<AgentClientTurnStart | undefined>()
    expect(client.turnStart).toEqual({ streamId: '', turn: 0, firstRun: 0, run: true })
  })

  describe('taken mid-turn, while the turn runs its tool batch', () => {
    // The turn's own later host events name calls in the snapshot's last message: they find them
    // as the same call, after the run start.
    const snapshot: Snapshot = {
      messages: [user, turnOne, osloResult, turnTwo],
      toolRuns: [osloRun, AgentToolRun.InputReady({ call: bergen })]
    }

    it("lands the batch on the last message's call", () => {
      const events = [
        ToolExecutionStarted.make({ ...host(), call: bergen }),
        ToolExecutionCompleted.make({
          ...host(),
          call: bergen,
          result: ToolResult.make({ toolCallId: 'call_0', content: '9C' })
        }),
        ...modelTurn(3, answer(done))
      ]

      expect(calls(applyEvents(fromSnapshot(snapshot, true), events))).toEqual(all(ended))
    })

    it("lands a request on the last message's call", () => {
      const approval = ToolApprovalRequest.make({
        requestId: 'approval:call_0',
        toolCallId: 'call_0',
        call: bergen
      })

      const events = [
        ToolApprovalRequested.make({ ...host(), call: bergen, request: approval }),
        AgentAwaitingInput.make({
          ...host(),
          requests: [approval],
          messages: [turnOne, osloResult, turnTwo],
          turns: 2,
          usage: zeroAgentUsage
        })
      ]

      expect(calls(applyEvents(fromSnapshot(snapshot, true), events))).toEqual(
        all(['weather {"city":"Oslo"}:Completed', 'weather {"city":"Bergen"}:ApprovalRequested'])
      )
    })
  })

  describe('taken mid-turn, while the turn streams its model call', () => {
    // The cursor lies past turn 2's `LLMStreamStart`; its model events name their execution's turn
    // (`executionTurn`, as the vercel-workflows sequencer sets it), so the rebuilt state starts
    // turn 2 from the first one and a reused `call_0` never lands on turn 1's call.
    const snapshot: Snapshot = { messages: [user, turnOne, osloResult], toolRuns: [osloRun] }

    const tagged = (executionId: string, turn: number) => ({
      ...host(),
      executionId,
      executionTurn: turn
    })

    const batch = (call: ToolCall, content: string) => [
      ToolExecutionStarted.make({ ...host(), call }),
      ToolExecutionCompleted.make({
        ...host(),
        call,
        result: ToolResult.make({ toolCallId: call.id, content })
      })
    ]

    const turnThree = [
      LLMStreamStart.make({ ...tagged('step-3:1', 3), turn: 3 }),
      AssistantMessageEvent.make({ ...tagged('step-3:1', 3), message: answer(done) })
    ]

    it("starts the turn from its first model event, off an earlier turn's call", () => {
      const events = [
        ToolInputEnd.make({ ...tagged('step-2:1', 2), call: bergen }),
        AssistantMessageEvent.make({ ...tagged('step-2:1', 2), message: turnTwo }),
        ...batch(bergen, '9C'),
        ...turnThree
      ]

      expect(calls(applyEvents(fromSnapshot(snapshot, true), events))).toEqual(all(ended))

      const started = applyEvents(fromSnapshot(snapshot, true), events.slice(0, 1))

      expect(started.client.turnStart).toMatchObject({ streamId: 'run-1', turn: 2, firstRun: 1 })
      expect(started.projection.turnStart).toMatchObject({ streamId: 'run-1', turn: 2 })
      expect(started.chat.turnStart).toMatchObject({ streamId: 'run-1', turn: 2 })
    })

    it("lets a redelivered execution's start supersede the resumed one", () => {
      const stockholm = weather('Stockholm')

      const events = [
        ToolInputEnd.make({ ...tagged('step-2:1', 2), call: stockholm }),
        LLMStreamStart.make({ ...tagged('step-2:2', 2), turn: 2 }),
        ToolInputEnd.make({ ...tagged('step-2:2', 2), call: bergen }),
        AssistantMessageEvent.make({ ...tagged('step-2:2', 2), message: turnTwo }),
        // The superseded execution keeps streaming; its events drop.
        AssistantMessageEvent.make({
          ...tagged('step-2:1', 2),
          message: answer('Now Stockholm', [stockholm])
        }),
        ...batch(bergen, '9C'),
        ...turnThree
      ]

      expect(calls(applyEvents(fromSnapshot(snapshot, true), events))).toEqual(all(ended))
    })

    it('drops an unseen execution of a turn the run moved past', () => {
      const stockholm = weather('Stockholm')

      const events = [
        ToolInputEnd.make({ ...tagged('step-2:1', 2), call: bergen }),
        // A losing execution of turn 1 the snapshot already committed.
        ToolInputEnd.make({ ...tagged('step-1:2', 1), call: stockholm }),
        AssistantMessageEvent.make({ ...tagged('step-2:1', 2), message: turnTwo }),
        ...batch(bergen, '9C'),
        ...turnThree
      ]

      expect(calls(applyEvents(fromSnapshot(snapshot, true), events))).toEqual(all(ended))
    })
  })
})
