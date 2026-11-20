import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  AssistantMessageEvent,
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
  QuestionAnswered,
  QuestionCancelled,
  QuestionPrompt,
  QuestionRequest,
  QuestionRequested,
  QuestionResponse,
  ToolApprovalDenied,
  ToolApprovalRequest,
  ToolApprovalRequested,
  ToolApprovalResponse,
  ToolCall,
  ToolExecutionAccepted,
  ToolExecutionCompleted,
  ToolExecutionError,
  ToolExecutionStarted,
  ToolInputEnd,
  ToolResult,
  interactionRequestId,
  makeBackgroundToolAcceptedResult,
  AgentAwaitingInput,
  AgentStart,
  ToolApprovalGranted,
  zeroAgentUsage,
  type AgentEvent
} from '@yolk-sdk/agent/protocol'
import {
  applyAgentEvent,
  initialAgentClientState,
  markAgentAborted,
  reduceAgentEvents,
  toolRunsFromHitlRequests,
  type AgentClientState,
  type AgentToolRun
} from '../../src/client'

// A request event (approval, question, input, interaction) for a call already past its request
// (answered, cancelled, denied or finished) is a replay: the loop asks for a call only until it
// settles, and a later turn reusing the id asks on its own run. A running call is not past it: a
// run that stopped while the call ran asks it again when it resumes.

const deploy = ToolCall.make({ id: 'call_0', name: 'deploy', params: { env: 'prod' } })

const unit = ToolCall.make({ id: 'call_0', name: 'question', params: { city: 'Oslo' } })

const word = ToolCall.make({ id: 'call_0', name: 'word', params: {} })

const doc = ToolCall.make({ id: 'call_0', name: 'document', params: {} })

const approval = ToolApprovalRequest.make({
  requestId: 'approval:call_0',
  toolCallId: 'call_0',
  call: deploy
})

const denial = ToolApprovalResponse.make({
  requestId: approval.requestId,
  toolCallId: 'call_0',
  decision: 'denied',
  source: 'user'
})

const question = QuestionRequest.make({
  requestId: 'question:call_0',
  toolCallId: 'call_0',
  call: unit,
  questions: [QuestionPrompt.make({ id: 'unit', prompt: 'Celsius or Fahrenheit?' })]
})

const questionResponse = (outcome: 'answered' | 'cancelled') =>
  QuestionResponse.make({
    requestId: question.requestId,
    toolCallId: 'call_0',
    outcome,
    source: 'user',
    answers: []
  })

const input = InputRequest.make({
  requestId: 'input:word:call_0',
  toolCallId: 'call_0',
  call: word,
  input: { kind: 'text-field' }
})

const inputResponse = (outcome: 'submitted' | 'cancelled') =>
  outcome === 'submitted'
    ? InputResponse.make({
        requestId: input.requestId,
        toolCallId: 'call_0',
        outcome,
        source: 'user',
        data: 'kind'
      })
    : InputResponse.make({
        requestId: input.requestId,
        toolCallId: 'call_0',
        outcome,
        source: 'user'
      })

const interaction = InteractionRequest.make({
  requestId: interactionRequestId(doc),
  toolCallId: 'call_0',
  call: doc,
  interaction: { kind: 'document-editor', actions: [{ id: 'publish', label: 'Publish' }] }
})

const interactionResponse = (outcome: 'submitted' | 'cancelled') =>
  outcome === 'submitted'
    ? InteractionResponse.make({
        requestId: interaction.requestId,
        toolCallId: 'call_0',
        outcome,
        source: 'user',
        actionId: 'publish',
        data: {}
      })
    : InteractionResponse.make({
        requestId: interaction.requestId,
        toolCallId: 'call_0',
        outcome,
        source: 'user'
      })

const result = ToolResult.make({ toolCallId: 'call_0', content: 'done' })

const accepted = makeBackgroundToolAcceptedResult({
  toolCallId: 'call_0',
  acceptance: BackgroundToolAccepted.make({ version: 1, executionId: 'owner:deploy' })
})

let sequence = 0

const eventId = () => `run-1:${(sequence += 1)}`

type Kind = 'approval' | 'question' | 'input' | 'interaction'

const asks: Record<
  Kind,
  { readonly call: ToolCall; readonly request: (eventId?: string) => AgentEvent }
> = {
  approval: {
    call: deploy,
    request: id => ToolApprovalRequested.make({ eventId: id, call: deploy, request: approval })
  },
  question: {
    call: unit,
    request: id => QuestionRequested.make({ eventId: id, request: question })
  },
  input: { call: word, request: id => InputRequested.make({ eventId: id, request: input }) },
  interaction: {
    call: doc,
    request: id => InteractionRequested.make({ eventId: id, request: interaction })
  }
}

/** How a call settles after its request: the events and the run state it leaves. */
type Settle = {
  readonly title: string
  readonly kind: Kind
  readonly events: ReadonlyArray<AgentEvent>
  readonly tag: AgentToolRun['_tag']
}

const ran = (call: ToolCall) => ({
  started: ToolExecutionStarted.make({ eventId: eventId(), call }),
  completed: ToolExecutionCompleted.make({ eventId: eventId(), call, result }),
  errored: ToolExecutionError.make({
    eventId: eventId(),
    call,
    message: 'failed',
    code: 'tool_error'
  }),
  accepted: ToolExecutionAccepted.make({ eventId: eventId(), call, result: accepted })
})

const settles: ReadonlyArray<Settle> = [
  {
    title: 'approval denied',
    kind: 'approval',
    events: [
      ToolApprovalDenied.make({
        eventId: eventId(),
        toolCallId: 'call_0',
        reason: 'No',
        response: denial
      })
    ],
    tag: 'Denied'
  },
  {
    title: 'approved call completed',
    kind: 'approval',
    events: [ran(deploy).started, ran(deploy).completed],
    tag: 'Completed'
  },
  {
    title: 'approved call errored',
    kind: 'approval',
    events: [ran(deploy).started, ran(deploy).errored],
    tag: 'Errored'
  },
  {
    title: 'approved call accepted',
    kind: 'approval',
    events: [ran(deploy).started, ran(deploy).accepted],
    tag: 'Accepted'
  },
  {
    title: 'question answered',
    kind: 'question',
    events: [QuestionAnswered.make({ eventId: eventId(), response: questionResponse('answered') })],
    tag: 'QuestionAnswered'
  },
  {
    title: 'question cancelled',
    kind: 'question',
    events: [
      QuestionCancelled.make({ eventId: eventId(), response: questionResponse('cancelled') })
    ],
    tag: 'QuestionCancelled'
  },
  {
    title: 'input submitted',
    kind: 'input',
    events: [InputSubmitted.make({ eventId: eventId(), response: inputResponse('submitted') })],
    tag: 'InputSubmitted'
  },
  {
    title: 'input cancelled',
    kind: 'input',
    events: [InputCancelled.make({ eventId: eventId(), response: inputResponse('cancelled') })],
    tag: 'InputCancelled'
  },
  {
    title: 'interaction submitted',
    kind: 'interaction',
    events: [
      InteractionSubmitted.make({ eventId: eventId(), response: interactionResponse('submitted') })
    ],
    tag: 'InteractionSubmitted'
  },
  {
    title: 'interaction cancelled',
    kind: 'interaction',
    events: [
      InteractionCancelled.make({
        eventId: eventId(),
        response: interactionResponse('cancelled')
      })
    ],
    tag: 'InteractionCancelled'
  }
]

const tags = (state: AgentClientState) => state.toolRuns.map(run => run._tag)

/** A turn whose model emits the call, then the call's request. */
const asked = (kind: Kind, turn = 1) => {
  const ask = asks[kind]

  return [
    LLMStreamStart.make({ eventId: eventId(), turn }),
    ToolInputEnd.make({ eventId: eventId(), call: ask.call }),
    AssistantMessageEvent.make({
      eventId: eventId(),
      message: AssistantAgentMessage.make({ parts: [HostToolCallPart.make({ call: ask.call })] })
    }),
    ask.request(eventId())
  ]
}

describe('a replayed request after its call settled', () => {
  describe.each(settles)('$title', ({ kind, events, tag }) => {
    it.each(['without', 'with'] as const)('keeps the run settled (%s event id)', ids => {
      const settled = reduceAgentEvents([...asked(kind), ...events])

      expect(tags(settled)).toEqual([tag])

      const replayed = reduceAgentEvents(
        [asks[kind].request(ids === 'with' ? eventId() : undefined)],
        settled
      )

      expect(replayed.toolRuns).toEqual(settled.toolRuns)
    })

    it('keeps the run settled when no turn start was seen', () => {
      // A state hydrated or built before turn tracking: the request matches the call by id.
      const settled = reduceAgentEvents([asks[kind].request(), ...events])

      expect(tags(settled)).toEqual([tag])
      expect(reduceAgentEvents([asks[kind].request()], settled).toolRuns).toEqual(settled.toolRuns)
    })
  })

  it("keeps an earlier turn's denied call when its request is replayed after a later turn", () => {
    const later = ToolCall.make({ id: 'call_0', name: 'weather', params: { city: 'Bergen' } })

    const settled = reduceAgentEvents([
      ...asked('approval'),
      ToolApprovalDenied.make({ eventId: eventId(), toolCallId: 'call_0', reason: 'No' }),
      LLMStreamStart.make({ eventId: eventId(), turn: 2 }),
      ToolInputEnd.make({ eventId: eventId(), call: later }),
      ran(later).started,
      ran(later).completed
    ])

    expect(tags(settled)).toEqual(['Denied', 'Completed'])

    const replayed = reduceAgentEvents(
      [ToolApprovalRequested.make({ call: deploy, request: approval })],
      settled
    )

    expect(replayed.toolRuns).toEqual(settled.toolRuns)
  })
})

describe('a request that is not a replay', () => {
  it('applies to a call reusing the id with other arguments', () => {
    const settled = reduceAgentEvents([
      asks.approval.request(),
      ran(deploy).started,
      ran(deploy).completed
    ])

    const staging = ToolCall.make({ id: 'call_0', name: 'deploy', params: { env: 'staging' } })

    const next = reduceAgentEvents(
      [
        ToolApprovalRequested.make({
          call: staging,
          request: ToolApprovalRequest.make({
            requestId: 'approval:call_0:staging',
            toolCallId: 'call_0',
            call: staging
          })
        })
      ],
      settled
    )

    expect(tags(next)).toEqual(['ApprovalRequested'])
  })

  it('replaces a still pending request with a newer one (an invalid input re-pends it)', () => {
    const pending = reduceAgentEvents(asked('input'))

    const repended = reduceAgentEvents(
      [
        InputRequested.make({
          eventId: eventId(),
          request: InputRequest.make({
            requestId: 'input:2',
            toolCallId: 'call_0',
            call: word,
            input: { kind: 'text-field' }
          })
        })
      ],
      pending
    )

    expect(repended.toolRuns).toMatchObject([
      { _tag: 'InputRequested', request: { requestId: 'input:2' } }
    ])
  })
})

describe('a running call asked again', () => {
  const granted = ToolApprovalResponse.make({
    requestId: approval.requestId,
    toolCallId: 'call_0',
    decision: 'approved',
    source: 'user'
  })

  const running = () =>
    reduceAgentEvents([
      ...asked('approval'),
      ToolApprovalGranted.make({ eventId: eventId(), toolCallId: 'call_0', response: granted }),
      ran(deploy).started
    ])

  it('applies an approval a resumed run asks again for a call it was running', () => {
    // The run stopped while the call ran (no terminal event reached the client); its resumed step
    // asks the same call again.
    const asking = reduceAgentEvents([asks.approval.request(eventId())], running())

    expect(asking.toolRuns).toMatchObject([{ _tag: 'ApprovalRequested', request: approval }])
  })

  it('applies an approval asked again after the person stopped the run and a new run started', () => {
    const restarted = reduceAgentEvents(
      [AgentStart.make({ eventId: eventId() }), asks.approval.request(eventId())],
      markAgentAborted(running())
    )

    expect(tags(restarted)).toEqual(['ApprovalRequested'])
  })

  it('applies an interaction asked again after an aborted run kept its running call', () => {
    // An accepted interaction runs (`Executing` with `interaction`); stopping keeps that run.
    const interacting = reduceAgentEvents([
      ...asked('interaction'),
      InteractionSubmitted.make({ eventId: eventId(), response: interactionResponse('submitted') }),
      ran(doc).started
    ])

    expect(interacting.toolRuns).toMatchObject([{ _tag: 'Executing', interaction: true }])

    const restarted = reduceAgentEvents(
      [AgentStart.make({ eventId: eventId() }), asks.interaction.request(eventId())],
      markAgentAborted(interacting)
    )

    expect(restarted.toolRuns).toMatchObject([
      { _tag: 'InteractionRequested', request: interaction }
    ])
  })
})

describe('a stale answer', () => {
  it('leaves a run holding another request alone (an answer to a request never seen)', () => {
    const later = QuestionRequest.make({
      requestId: 'question:call_0:2',
      toolCallId: 'call_0',
      call: unit,
      questions: [QuestionPrompt.make({ id: 'unit', prompt: 'Kelvin?' })]
    })

    // Hydrated from the pending requests, without the earlier request's run.
    const hydrated: AgentClientState = {
      ...initialAgentClientState,
      toolRuns: toolRunsFromHitlRequests([later])
    }

    const answered = applyAgentEvent(
      hydrated,
      QuestionAnswered.make({ response: questionResponse('answered') })
    )

    expect(answered.toolRuns).toEqual(hydrated.toolRuns)
  })
})

describe('the run status for a replay', () => {
  it('stays when a kept request names a call past its request (requests never move it)', () => {
    const settled = reduceAgentEvents([
      ...asked('question'),
      QuestionAnswered.make({ eventId: eventId(), response: questionResponse('answered') })
    ])

    for (const ids of ['without', 'with'] as const) {
      const replayed = reduceAgentEvents(
        [asks.question.request(ids === 'with' ? eventId() : undefined)],
        settled
      )

      expect(replayed.toolRuns).toEqual(settled.toolRuns)
      expect(replayed.status).toEqual(settled.status)
    }
  })

  it('stays when a pause asks only for calls past their request', () => {
    const settled = reduceAgentEvents([
      ...asked('question'),
      QuestionAnswered.make({ eventId: eventId(), response: questionResponse('answered') })
    ])

    const paused = applyAgentEvent(
      settled,
      AgentAwaitingInput.make({
        requests: [question],
        messages: [],
        turns: 1,
        usage: zeroAgentUsage
      })
    )

    expect(paused.status).toEqual(settled.status)
  })

  it('blocks only on the requests still pending in a pause', () => {
    const other = ToolCall.make({ id: 'call_1', name: 'deploy', params: { env: 'staging' } })

    const pending = ToolApprovalRequest.make({
      requestId: 'approval:call_1',
      toolCallId: 'call_1',
      call: other
    })

    const state = reduceAgentEvents([
      ...asked('question'),
      QuestionAnswered.make({ eventId: eventId(), response: questionResponse('answered') }),
      ToolApprovalRequested.make({ eventId: eventId(), call: other, request: pending }),
      AgentAwaitingInput.make({
        eventId: eventId(),
        requests: [question, pending],
        messages: [],
        turns: 1,
        usage: zeroAgentUsage
      })
    ])

    expect(state.status).toMatchObject({
      _tag: 'Blocked',
      kind: 'permission',
      requests: [pending]
    })
  })
})

describe('a replayed start of a finished call', () => {
  it.each([
    ['completed', ran(deploy).completed, 'Completed'],
    ['errored', ran(deploy).errored, 'Errored']
  ] as const)('keeps the %s run and the run status', (_, finished, tag) => {
    const settled = reduceAgentEvents([asks.approval.request(), ran(deploy).started, finished])

    expect(tags(settled)).toEqual([tag])

    for (const ids of ['without', 'with'] as const) {
      const replayed = reduceAgentEvents(
        [
          ToolExecutionStarted.make({
            eventId: ids === 'with' ? eventId() : undefined,
            call: deploy
          })
        ],
        settled
      )

      expect(replayed.toolRuns).toEqual(settled.toolRuns)
      expect(replayed.status).toEqual(settled.status)
    }
  })
})
