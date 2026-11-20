import { describe, expect, it } from '@effect/vitest'
import { Predicate } from 'effect'
import {
  AgentAwaitingInput,
  AgentEnd,
  AgentStart,
  AssistantAgentMessage,
  AssistantMessageEvent,
  AssistantTextPart,
  BackgroundToolAccepted,
  HostToolCallPart,
  LLMStreamStart,
  LLMTextDelta,
  ProviderToolCallPart,
  ProviderToolResult,
  QuestionAnswered,
  QuestionPrompt,
  QuestionRequest,
  QuestionRequested,
  QuestionResponse,
  ToolApprovalGranted,
  ToolApprovalRequest,
  ToolApprovalRequested,
  ToolApprovalResponse,
  ToolCall,
  ToolExecutionAccepted,
  ToolExecutionCompleted,
  ToolExecutionStarted,
  ToolInputDelta,
  ToolInputEnd,
  ToolInputStart,
  ToolResult,
  ToolResultMessage,
  UserMessage,
  UserMessageEvent,
  makeBackgroundToolAcceptedResult,
  zeroAgentUsage,
  type AgentEvent,
  type AgentMessage
} from '@yolk-sdk/agent/protocol'
import {
  applyAgentEvent,
  initialAgentClientState,
  reduceAgentEvents,
  type AgentClientState
} from '../../src/client'
import { AgentToolRun } from '../../src/client/state.ts'

// Providers that number calls per response reuse `call_0` in every turn: each turn's call gets its
// own tool run, and replays without event ids of an earlier turn's events act on the earlier run.

const weather = (city: string) => ToolCall.make({ id: 'call_0', name: 'weather', params: { city } })

const oslo = weather('Oslo')

const bergen = weather('Bergen')

const lyon = weather('Lyon')

const exporting = ToolCall.make({ id: 'call_0', name: 'export', params: { format: 'csv' } })

const result = (content: string) => ToolResult.make({ toolCallId: 'call_0', content })

const accepted = makeBackgroundToolAcceptedResult({
  toolCallId: exporting.id,
  acceptance: BackgroundToolAccepted.make({ version: 1, executionId: 'owner:export' })
})

const acknowledged = ToolResultMessage.make({
  toolCallId: exporting.id,
  content: accepted.content,
  acceptance: accepted.acceptance
})

let sequence = 0

type Identity = {
  readonly eventId: string
  readonly streamId: string
  readonly executionId?: string
}

type Tagging = 'tagged' | 'plain'

const identity = (tagging: Tagging, executionId: string, streamId = 'run-1'): Identity => {
  const eventId = `${streamId}:${(sequence += 1)}`

  return tagging === 'tagged' ? { eventId, streamId, executionId } : { eventId, streamId }
}

/** A host event (no execution), with its own event id. */
const host = (streamId = 'run-1') => ({ eventId: `${streamId}:host:${(sequence += 1)}`, streamId })

const answer = (content: string, calls: ReadonlyArray<ToolCall> = []) =>
  AssistantAgentMessage.make({
    parts: [
      AssistantTextPart.make({ content }),
      ...calls.map(call => HostToolCallPart.make({ call }))
    ]
  })

/** One model turn: its start, text, the call's input stream and its `AssistantMessage`. */
const modelTurn = (
  tagging: Tagging,
  executionId: string,
  turn: number,
  message: AssistantAgentMessage,
  call?: ToolCall,
  streamId?: string
): ReadonlyArray<AgentEvent> => {
  const id = () => identity(tagging, executionId, streamId)

  return [
    LLMStreamStart.make({ ...id(), turn }),
    LLMTextDelta.make({ ...id(), text: 'Thinking' }),
    ...(call === undefined
      ? []
      : [
          ToolInputStart.make({ ...id(), id: call.id, name: call.name }),
          ToolInputDelta.make({ ...id(), id: call.id, delta: JSON.stringify(call.params) }),
          ToolInputEnd.make({ ...id(), call })
        ]),
    AssistantMessageEvent.make({ ...id(), message })
  ]
}

/** The tool batch running a call to completion. */
const batch = (call: ToolCall, value: ToolResult, streamId?: string) => [
  ToolExecutionStarted.make({ ...host(streamId), call }),
  ToolExecutionCompleted.make({ ...host(streamId), call, result: value })
]

/** The tool batch handing a background call to its owner. */
const background = (streamId?: string) => [
  ToolExecutionStarted.make({ ...host(streamId), call: exporting }),
  ToolExecutionAccepted.make({ ...host(streamId), call: exporting, result: accepted })
]

const end = (messages: ReadonlyArray<AgentMessage>, streamId?: string) =>
  AgentEnd.make({ ...host(streamId), messages, turns: 1, usage: zeroAgentUsage })

/** A run as `id params:state`. */
const describeRun = (run: AgentToolRun) => {
  if ('call' in run) return `${run.call.id} ${JSON.stringify(run.call.params)}:${run._tag}`

  if ('request' in run && run.request !== undefined) {
    return `${run.request.call.id} ${JSON.stringify(run.request.call.params)}:${run._tag}`
  }

  return run._tag
}

const runs = (state: AgentClientState) => state.toolRuns.map(describeRun)

const reduce = (events: ReadonlyArray<AgentEvent>, initial = initialAgentClientState) =>
  reduceAgentEvents(events, initial)

const turnOne = answer('Oslo first', [oslo])

const turnTwo = answer('Now Bergen', [bergen])

const startedExport = answer('Starting the export', [exporting])

const working = answer('Working on it')

describe('tool runs of calls that reuse an id across turns', () => {
  it.each(['tagged', 'plain'] as const)(
    "keeps an earlier turn's run when a later turn reuses its call id (%s)",
    tagging => {
      const firstTurn = [
        ...modelTurn(tagging, 'model-1:1', 1, turnOne, oslo),
        ...batch(oslo, result('12C'))
      ]

      const secondTurn = modelTurn(tagging, 'model-2:1', 2, turnTwo, bergen)

      expect(runs(reduce([...firstTurn, ...secondTurn]))).toEqual([
        'call_0 {"city":"Oslo"}:Completed',
        'call_0 {"city":"Bergen"}:InputReady'
      ])

      const done = answer('Oslo 12C, Bergen 9C')

      const messages = [
        turnOne,
        ToolResultMessage.make({ toolCallId: 'call_0', content: '12C' }),
        turnTwo,
        ToolResultMessage.make({ toolCallId: 'call_0', content: '9C' }),
        done
      ]

      const ended = reduce([
        ...firstTurn,
        ...secondTurn,
        ...batch(bergen, result('9C')),
        ...modelTurn(tagging, 'model-3:1', 3, done),
        end(messages)
      ])

      expect(runs(ended)).toEqual([
        'call_0 {"city":"Oslo"}:Completed',
        'call_0 {"city":"Bergen"}:Completed'
      ])

      expect(ended.messages).toEqual(messages)
    }
  )

  it.each(['tagged', 'plain'] as const)(
    "gives a later turn's call its own run when an accepted background call has its id (%s)",
    tagging => {
      const before = reduce([
        ...modelTurn(tagging, 'model-1:1', 1, startedExport, exporting),
        ...background(),
        ...modelTurn(tagging, 'model-2:1', 2, turnTwo, bergen)
      ])

      const [started, completed] = batch(bergen, result('9C'))

      const running = reduce([started], before)

      expect(runs(running)).toEqual([
        'call_0 {"format":"csv"}:Accepted',
        'call_0 {"city":"Bergen"}:Executing'
      ])

      expect(running.status).toMatchObject({ _tag: 'Working', activity: { _tag: 'Tools' } })

      expect(runs(reduce([completed], running))).toEqual([
        'call_0 {"format":"csv"}:Accepted',
        'call_0 {"city":"Bergen"}:Completed'
      ])
    }
  )

  it('keeps one run when an untagged step of a turn runs again', () => {
    // A redelivered step without `executionId` repeats the call: the turn keeps its start.
    const state = reduce([
      ...modelTurn('plain', 'model-1:1', 1, turnOne, oslo),
      ...batch(oslo, result('12C')),
      LLMStreamStart.make({ ...host(), turn: 2 }),
      ToolInputEnd.make({ ...host(), call: bergen }),
      ...modelTurn('plain', 'model-2:2', 2, turnTwo, bergen),
      ...batch(bergen, result('9C'))
    ])

    expect(runs(state)).toEqual([
      'call_0 {"city":"Oslo"}:Completed',
      'call_0 {"city":"Bergen"}:Completed'
    ])
  })

  it('starts a new turn when a later run numbers its turns afresh without AgentStart', () => {
    const plainTurn = (turn: number, message: AssistantAgentMessage, call: ToolCall) => [
      LLMStreamStart.make({ turn }),
      ToolInputEnd.make({ call }),
      AssistantMessageEvent.make({ message })
    ]

    const state = reduce([
      ...plainTurn(1, turnOne, oslo),
      ToolExecutionStarted.make({ call: oslo }),
      ToolExecutionCompleted.make({ call: oslo, result: result('12C') }),
      AgentEnd.make({ messages: [turnOne], turns: 1, usage: zeroAgentUsage }),
      ...plainTurn(1, turnTwo, bergen)
    ])

    expect(runs(state)).toEqual([
      'call_0 {"city":"Oslo"}:Completed',
      'call_0 {"city":"Bergen"}:InputReady'
    ])
  })

  it("runs a later run's call whose id the transcript acknowledged for a background call", () => {
    // Run 1 hands `call_0` to a background owner; its transcript acknowledges it. Run 2 reuses it.
    const firstRun = [
      AgentStart.make(host('run-1')),
      ...modelTurn('tagged', 'model-1:1', 1, startedExport, exporting, 'run-1'),
      ...background('run-1'),
      ...modelTurn('tagged', 'model-2:1', 2, working, undefined, 'run-1'),
      end([startedExport, acknowledged, working], 'run-1')
    ]

    const secondRun = [
      AgentStart.make(host('run-2')),
      UserMessageEvent.make({
        ...host('run-2'),
        message: UserMessage.make({ content: 'Bergen?' })
      }),
      ...modelTurn('tagged', 'model-1:1b', 1, turnTwo, bergen, 'run-2'),
      ...batch(bergen, result('9C'), 'run-2')
    ]

    expect(runs(reduce([...firstRun, ...secondRun]))).toEqual([
      'call_0 {"format":"csv"}:Accepted',
      'call_0 {"city":"Bergen"}:Completed'
    ])
  })

  describe('across a pause', () => {
    const approval = ToolApprovalRequest.make({
      requestId: 'approval:call_0',
      toolCallId: 'call_0',
      call: bergen
    })

    const approved = ToolApprovalResponse.make({
      requestId: approval.requestId,
      toolCallId: 'call_0',
      decision: 'approved',
      source: 'user'
    })

    it.each(['tagged', 'plain'] as const)(
      "acts on the paused call, not an earlier turn's accepted call with its id (%s)",
      tagging => {
        const paused = reduce([
          ...modelTurn(tagging, 'model-1:1', 1, startedExport, exporting),
          ...background(),
          ...modelTurn(tagging, 'model-2:1', 2, turnTwo, bergen),
          ToolApprovalRequested.make({ ...host(), call: bergen, request: approval }),
          AgentAwaitingInput.make({
            ...host(),
            requests: [approval],
            messages: [startedExport, acknowledged, turnTwo],
            turns: 2,
            usage: zeroAgentUsage
          })
        ])

        expect(runs(paused)).toEqual([
          'call_0 {"format":"csv"}:Accepted',
          'call_0 {"city":"Bergen"}:ApprovalRequested'
        ])

        expect(paused.status).toMatchObject({ _tag: 'Blocked', kind: 'permission' })

        const done = answer('Bergen is 9C')

        const resumed = reduce(
          [
            ToolApprovalGranted.make({ ...host(), toolCallId: 'call_0', response: approved }),
            ...batch(bergen, result('9C')),
            ...modelTurn(tagging, 'model-3:1', 3, done),
            end([done])
          ],
          paused
        )

        expect(runs(resumed)).toEqual([
          'call_0 {"format":"csv"}:Accepted',
          'call_0 {"city":"Bergen"}:Completed'
        ])

        expect(resumed.status._tag).toBe('Done')
      }
    )
  })

  describe('replays without event ids', () => {
    const unit = ToolCall.make({ id: 'call_0', name: 'question', params: { city: 'Oslo' } })

    const question = QuestionRequest.make({
      requestId: 'question:call_0',
      toolCallId: 'call_0',
      call: unit,
      questions: [QuestionPrompt.make({ id: 'unit', prompt: 'Celsius or Fahrenheit?' })]
    })

    const answered = QuestionResponse.make({
      requestId: question.requestId,
      toolCallId: 'call_0',
      outcome: 'answered',
      source: 'user',
      answers: []
    })

    // Turn 1 hands `call_0` to a background owner; turn 2 reuses the id; turn 3 is streaming.
    const threeTurns = reduce([
      ...modelTurn('tagged', 'model-1:1', 1, startedExport, exporting),
      ...background(),
      ...modelTurn('tagged', 'model-2:1', 2, turnTwo, bergen),
      ...batch(bergen, result('9C')),
      ...modelTurn('tagged', 'model-3:1', 3, working)
    ])

    const expected = ['call_0 {"format":"csv"}:Accepted', 'call_0 {"city":"Bergen"}:Completed']

    it('keeps the background fence for a replay of the accepted call', () => {
      expect(runs(threeTurns)).toEqual(expected)

      for (const replayed of [
        ToolExecutionStarted.make({ call: exporting }),
        ToolApprovalRequested.make({
          call: exporting,
          request: ToolApprovalRequest.make({
            requestId: 'approval:export',
            toolCallId: 'call_0',
            call: exporting
          })
        })
      ]) {
        expect(runs(applyAgentEvent(threeTurns, replayed))).toEqual(expected)
      }
    })

    it("acts on the earlier turn's run for a replayed tool-batch event of its call", () => {
      const replayed = ToolExecutionCompleted.make({ call: bergen, result: result('9C') })

      expect(runs(applyAgentEvent(threeTurns, replayed))).toEqual(expected)
    })

    it("acts on the run holding the request for a replayed answer to an earlier turn's question", () => {
      const asked = reduce([
        ...modelTurn('tagged', 'model-1:1', 1, answer('Which unit?', [unit]), unit),
        QuestionRequested.make({ ...host(), request: question }),
        QuestionAnswered.make({ ...host(), response: answered }),
        ...modelTurn('tagged', 'model-2:1', 2, turnTwo, bergen),
        ...batch(bergen, result('9C')),
        ...modelTurn('tagged', 'model-3:1', 3, working)
      ])

      const shown = [
        'call_0 {"city":"Oslo"}:QuestionAnswered',
        'call_0 {"city":"Bergen"}:Completed'
      ]

      expect(runs(asked)).toEqual(shown)

      for (const replayed of [
        QuestionAnswered.make({ response: answered }),
        QuestionRequested.make({ request: question })
      ]) {
        const state = applyAgentEvent(asked, replayed)

        expect(state.toolRuns).toHaveLength(2)
        expect(runs(state)[1]).toBe(shown[1])
      }

      const replayedAnswer = applyAgentEvent(asked, QuestionAnswered.make({ response: answered }))

      expect(replayedAnswer.toolRuns[0]).toMatchObject({
        _tag: 'QuestionAnswered',
        request: question
      })
    })

    it("leaves a later turn's pending question alone for a replayed answer to an earlier one", () => {
      const later = QuestionRequest.make({
        requestId: 'question:call_0:2',
        toolCallId: 'call_0',
        call: ToolCall.make({ id: 'call_0', name: 'question', params: { city: 'Bergen' } }),
        questions: [QuestionPrompt.make({ id: 'unit', prompt: 'Celsius or Fahrenheit?' })]
      })

      const pending = reduce([
        ...modelTurn('tagged', 'model-1:1', 1, answer('Which unit?', [unit]), unit),
        QuestionRequested.make({ ...host(), request: question }),
        QuestionAnswered.make({ ...host(), response: answered }),
        ...modelTurn('tagged', 'model-2:1', 2, answer('And Bergen?', [later.call]), later.call),
        QuestionRequested.make({ ...host(), request: later })
      ])

      const replayed = applyAgentEvent(pending, QuestionAnswered.make({ response: answered }))

      expect(runs(replayed)).toEqual([
        'call_0 {"city":"Oslo"}:QuestionAnswered',
        'call_0 {"city":"Bergen"}:QuestionRequested'
      ])
    })

    it('keeps the transcript fence when a later turn holds another call with the id', () => {
      const hydrated: AgentClientState = {
        ...initialAgentClientState,
        messages: [startedExport, acknowledged]
      }

      const running = reduce(
        [
          LLMStreamStart.make({ ...host(), turn: 2 }),
          ToolInputEnd.make({ ...host(), call: bergen }),
          ToolExecutionStarted.make({ ...host(), call: bergen })
        ],
        hydrated
      )

      const replayed = applyAgentEvent(running, ToolExecutionStarted.make({ call: exporting }))

      expect(runs(replayed)).toEqual(['call_0 {"city":"Bergen"}:Executing'])
    })

    it('keeps the transcript fence for a replay of an acknowledged call after hydration', () => {
      // A client hydrated from the transcript sees a later turn start, then a replayed start of the
      // acknowledged call, then a new call reusing its id.
      const hydrated: AgentClientState = {
        ...initialAgentClientState,
        messages: [startedExport, acknowledged]
      }

      const fenced = reduce(
        [
          LLMStreamStart.make({ ...host(), turn: 2 }),
          ToolExecutionStarted.make({ call: exporting })
        ],
        hydrated
      )

      expect(fenced.toolRuns).toEqual([])

      const reused = reduce(
        [
          ToolInputStart.make({ ...host(), id: 'call_0', name: 'weather' }),
          ToolInputEnd.make({ ...host(), call: bergen }),
          ToolExecutionStarted.make({ ...host(), call: bergen })
        ],
        fenced
      )

      expect(runs(reused)).toEqual(['call_0 {"city":"Bergen"}:Executing'])
    })
  })

  it("removes a superseded execution's call, not an earlier turn's provider result with its id", () => {
    const search = ToolCall.make({ id: 'call_0', name: 'web_search', params: { q: 'Oslo' } })
    const found = ToolResult.make({ toolCallId: 'call_0', content: 'Oslo' })

    const provided = AssistantAgentMessage.make({
      parts: [
        ProviderToolCallPart.make({ call: search }),
        AssistantTextPart.make({ content: 'Found Oslo' })
      ]
    })

    const state = reduce([
      LLMStreamStart.make({ ...identity('tagged', 'model-1:1'), turn: 1 }),
      ProviderToolResult.make({ ...identity('tagged', 'model-1:1'), call: search, result: found }),
      AssistantMessageEvent.make({ ...identity('tagged', 'model-1:1'), message: provided }),
      LLMStreamStart.make({ ...identity('tagged', 'model-2:1'), turn: 2 }),
      ToolInputEnd.make({ ...identity('tagged', 'model-2:1'), call: bergen }),
      // A newer execution of turn 2 supersedes the first, and reuses the id for its own call.
      LLMStreamStart.make({ ...identity('tagged', 'model-2:2'), turn: 2 }),
      ToolInputEnd.make({ ...identity('tagged', 'model-2:2'), call: lyon })
    ])

    expect(runs(state)).toEqual([
      'call_0 {"q":"Oslo"}:ProviderCompleted',
      'call_0 {"city":"Lyon"}:InputReady'
    ])
  })

  it("reconciles an earlier turn's runs only, not an older turn's run with the id", () => {
    // Turn 1 keeps a provider result under `call_0`. Turn 2 runs twice: the newer execution, shown,
    // reuses `call_0`; the older one committed. Turn 3 starts, then the pause commits turn 2's
    // older answer: only turn 2's call is removed.
    const search = ToolCall.make({ id: 'call_0', name: 'web_search', params: { q: 'Oslo' } })
    const found = ToolResult.make({ toolCallId: 'call_0', content: 'Oslo' })

    const provided = AssistantAgentMessage.make({
      parts: [
        ProviderToolCallPart.make({ call: search }),
        AssistantTextPart.make({ content: 'Found Oslo' })
      ]
    })

    const committed = answer('Oslo it is')
    const shown = answer('Now Lyon', [lyon])
    const later = answer('Turn three')

    const state = reduce([
      LLMStreamStart.make({ ...identity('tagged', 'model-1:1'), turn: 1 }),
      ProviderToolResult.make({ ...identity('tagged', 'model-1:1'), call: search, result: found }),
      AssistantMessageEvent.make({ ...identity('tagged', 'model-1:1'), message: provided }),
      LLMStreamStart.make({ ...identity('tagged', 'model-2:1'), turn: 2 }),
      AssistantMessageEvent.make({ ...identity('tagged', 'model-2:1'), message: committed }),
      LLMStreamStart.make({ ...identity('tagged', 'model-2:2'), turn: 2 }),
      ToolInputEnd.make({ ...identity('tagged', 'model-2:2'), call: lyon }),
      AssistantMessageEvent.make({ ...identity('tagged', 'model-2:2'), message: shown }),
      LLMStreamStart.make({ ...identity('tagged', 'model-3:1'), turn: 3 }),
      AssistantMessageEvent.make({ ...identity('tagged', 'model-3:1'), message: later })
    ])

    expect(runs(state)).toEqual([
      'call_0 {"q":"Oslo"}:ProviderCompleted',
      'call_0 {"city":"Lyon"}:InputReady'
    ])

    const paused = reduce(
      [
        AgentAwaitingInput.make({
          ...host(),
          requests: [
            QuestionRequest.make({
              requestId: 'question:call_7',
              toolCallId: 'call_7',
              call: ToolCall.make({ id: 'call_7', name: 'question', params: {} }),
              questions: [QuestionPrompt.make({ id: 'go', prompt: 'Go on?' })]
            })
          ],
          messages: [provided, committed, later],
          turns: 3,
          usage: zeroAgentUsage
        })
      ],
      state
    )

    expect(runs(paused)).toEqual(['call_0 {"q":"Oslo"}:ProviderCompleted'])
  })

  describe("the latest turn's start after earlier runs are removed", () => {
    it('still holds the turn when a fenced replay drops an earlier stale run', () => {
      // A hydrated state holds a stale pending approval of the acknowledged call (turn 1).
      const hydrated: AgentClientState = {
        ...initialAgentClientState,
        messages: [startedExport, acknowledged],
        toolRuns: [
          AgentToolRun.ApprovalRequested({
            call: exporting,
            request: ToolApprovalRequest.make({
              requestId: 'approval:export',
              toolCallId: 'call_0',
              call: exporting
            })
          })
        ]
      }

      const streaming = reduce(
        [
          LLMStreamStart.make({ ...host(), turn: 2 }),
          ToolInputStart.make({ ...host(), id: 'call_1', name: 'weather' }),
          // The replayed start of the acknowledged call drops the stale run before the turn's.
          ToolExecutionStarted.make({ call: exporting })
        ],
        hydrated
      )

      expect(runs(streaming)).toEqual(['InputStreaming'])

      const ended = reduce(
        [
          ToolInputDelta.make({ ...host(), id: 'call_1', delta: '{}' }),
          ToolInputEnd.make({
            ...host(),
            call: ToolCall.make({ id: 'call_1', name: 'weather', params: {} })
          })
        ],
        streaming
      )

      expect(runs(ended)).toEqual(['call_1 {}:InputReady'])
    })

    it('still holds the turn when a retried start drops an earlier unfinished input', () => {
      const state: AgentClientState = {
        ...initialAgentClientState,
        toolRuns: [
          AgentToolRun.InputStreaming({ id: 'call_9', name: 'weather', input: '{' }),
          AgentToolRun.InputReady({ call: bergen })
        ],
        turnStart: { streamId: '', turn: 2, firstRun: 1 }
      }

      // An untagged retry of turn 2 drops the unfinished input, then streams its call again.
      const retried = reduce(
        [LLMStreamStart.make({ turn: 2 }), ToolInputEnd.make({ call: bergen })],
        state
      )

      expect(runs(retried)).toEqual(['call_0 {"city":"Bergen"}:InputReady'])
      expect(retried.turnStart?.firstRun).toBe(0)
    })
  })

  it('keeps one run per call id until a turn start is seen (states built before turn tracking)', () => {
    const state = reduce([
      ...batch(oslo, result('12C')),
      ToolExecutionStarted.make({ ...host(), call: bergen })
    ])

    expect(runs(state)).toEqual(['call_0 {"city":"Bergen"}:Executing'])
    expect(state.toolRuns.filter(run => Predicate.isTagged(run, 'Completed'))).toEqual([])
  })
})
