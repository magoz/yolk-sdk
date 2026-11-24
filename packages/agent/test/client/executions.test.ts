import { describe, expect, it } from '@effect/vitest'
import { Predicate } from 'effect'
import {
  AgentAwaitingInput,
  AgentEnd,
  AgentStart,
  AssistantAgentMessage,
  BackgroundToolAccepted,
  AssistantMessageEvent,
  AssistantTextPart,
  HostToolCallPart,
  LLMStreamStart,
  LLMTextDelta,
  ProviderToolCallPart,
  ProviderToolResult,
  QuestionPrompt,
  QuestionRequest,
  QuestionAnswered,
  QuestionRequested,
  QuestionResponse,
  ToolApprovalDenied,
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
  TurnStart,
  UserMessage,
  UserMessageEvent,
  makeBackgroundToolAcceptedResult,
  zeroAgentUsage,
  type AgentEvent,
  type AgentMessage
} from '@yolk-sdk/agent/protocol'
import { reduceAgentEvents, type AgentExecutions } from '../../src/client'
import { missedAgentExecutionStart } from '../../src/client/executions.ts'
import {
  applyAgentEventToChatProjection,
  initialAgentChatState,
  makeAgentChatEventProjectionState,
  reduceAgentChatState
} from '../../src/react/chat-core.ts'
import { AgentChatAction } from '../../src/react/chat-actions.ts'
import { appendProtocolMessage, type AgentChatMessage } from '../../src/react/chat-messages.ts'

// Model-step executions (events carrying `executionId`): a retried or redelivered model step
// streams a second answer for the same turn. Every scenario runs through the client reducer and
// both chat reducers.

const A = 'step-1:1'

const B = 'step-1:2'

let sequence = 0

/** A live event of one execution; ids are unique per execution, as the sequencer writes them. */
const live = <Event extends AgentEvent>(
  make: (identity: Identity) => Event,
  executionId: string,
  streamId = 'run-1'
) => make({ eventId: `${streamId}:${(sequence += 1)}:${executionId}`, executionId, streamId })

/** A host event every execution writes identically (plain id, no execution). */
const plain = <Event extends AgentEvent>(
  make: (identity: PlainIdentity) => Event,
  id: string,
  streamId = 'run-1'
) => make({ eventId: `${streamId}:${id}`, streamId })

type Identity = {
  readonly eventId: string
  readonly executionId: string
  readonly streamId: string
}

type PlainIdentity = { readonly eventId: string; readonly streamId: string }

const answer = (content: string, calls: ReadonlyArray<ToolCall> = []) =>
  AssistantAgentMessage.make({
    parts: [
      AssistantTextPart.make({ content }),
      ...calls.map(call => HostToolCallPart.make({ call }))
    ]
  })

const start = (executionId: string, turn: number, streamId?: string) =>
  live(identity => LLMStreamStart.make({ ...identity, turn }), executionId, streamId)

const delta = (executionId: string, text: string, streamId?: string) =>
  live(identity => LLMTextDelta.make({ ...identity, text }), executionId, streamId)

const message = (executionId: string, value: AssistantAgentMessage, streamId?: string) =>
  live(
    identity => AssistantMessageEvent.make({ ...identity, message: value }),
    executionId,
    streamId
  )

const end = (id: string, messages: ReadonlyArray<AgentMessage>) =>
  plain(identity => AgentEnd.make({ ...identity, messages, turns: 1, usage: zeroAgentUsage }), id)

const project = (events: ReadonlyArray<AgentEvent>) => ({
  client: reduceAgentEvents(events),
  projection: events.reduce(
    (state, event) => applyAgentEventToChatProjection(state, event),
    makeAgentChatEventProjectionState()
  ).chatMessages,
  chat: events.reduce(
    (state, event) => reduceAgentChatState(state, AgentChatAction.Event({ event })),
    initialAgentChatState
  ).chatMessages
})

/** A chat message's text, and its tool calls as `id:state`. */
const describeParts = (chatMessage: AgentChatMessage) =>
  chatMessage.parts
    .flatMap(part => {
      if (Predicate.isTagged(part, 'Text')) return [part.content]

      if (Predicate.isTagged(part, 'ToolCall')) return [`${part.call.id}:${part.state._tag}`]

      return []
    })
    .join(' | ')

/** Per assistant chat message: its text, and its tool calls as `id:state`. */
const shown = (messages: ReadonlyArray<AgentChatMessage>) =>
  messages.flatMap(chatMessage =>
    chatMessage.role !== 'assistant' ? [] : [describeParts(chatMessage)]
  )

const expectBothChats = (result: ReturnType<typeof project>, expected: ReadonlyArray<string>) => {
  expect(shown(result.projection)).toEqual(expected)
  expect(shown(result.chat)).toEqual(expected)
}

describe('model-step executions', () => {
  it('drops a superseded execution that keeps streaming beside the newer one (concurrent)', () => {
    const result = project([
      start(A, 1),
      delta(A, 'Hel'),
      start(B, 1),
      delta(B, 'Sorry'),
      delta(A, 'lo w'),
      delta(B, ', I cannot')
    ])

    expect(result.client.text).toBe('Sorry, I cannot')
    expectBothChats(result, ['Sorry, I cannot'])
  })

  it('replaces a superseded execution that settled its answer, keeping earlier turns', () => {
    const call = ToolCall.make({ id: 'call_0', name: 'weather', params: {} })
    const turnOne = answer('Turn one', [call])
    const result0 = ToolResult.make({ toolCallId: call.id, content: '72F' })
    const toolResult = ToolResultMessage.make({ toolCallId: call.id, content: result0.content })
    const committed = answer('Sorry, I cannot')

    const events = [
      start('step-0:1', 1),
      delta('step-0:1', 'Turn one'),
      live(identity => ToolInputEnd.make({ ...identity, call }), 'step-0:1'),
      message('step-0:1', turnOne),
      plain(identity => ToolExecutionStarted.make({ ...identity, call }), 'tool:0'),
      plain(
        identity => ToolExecutionCompleted.make({ ...identity, call, result: result0 }),
        'tool:1'
      ),
      start(A, 2),
      delta(A, 'Hello world'),
      message(A, answer('Hello world')),
      start(B, 2),
      delta(B, 'Sorry, I cannot'),
      message(B, committed)
    ]

    const live2 = project(events)

    expect(live2.client.liveMessages).toEqual([turnOne, committed])
    expectBothChats(live2, ['Turn one | call_0:Completed', 'Sorry, I cannot'])

    const ended = project([...events, end('end', [turnOne, toolResult, committed])])

    expect(ended.client.messages).toEqual([turnOne, toolResult, committed])
    expect(ended.client.liveMessages).toEqual([])
    expectBothChats(ended, ['Turn one | call_0:Completed', 'Sorry, I cannot'])
  })

  it('removes tool calls a superseded execution produced that no host step acted on', () => {
    const abandoned = ToolCall.make({ id: 'call_a', name: 'weather', params: {} })
    const retried = ToolCall.make({ id: 'call_b', name: 'weather', params: {} })

    const result = project([
      start(A, 1),
      live(identity => ToolInputStart.make({ ...identity, id: abandoned.id }), A),
      live(identity => ToolInputEnd.make({ ...identity, call: abandoned }), A),
      start(B, 1),
      live(identity => ToolInputStart.make({ ...identity, id: retried.id }), B),
      live(identity => ToolInputEnd.make({ ...identity, call: retried }), B)
    ])

    expect(result.client.toolRuns.map(run => run._tag)).toEqual(['InputReady'])
    expect(JSON.stringify(result.client.toolRuns)).not.toContain(abandoned.id)
    expectBothChats(result, ['call_b:Called'])
  })

  it('shows the committed answer when the older execution commits while the newer streams', () => {
    const committed = answer('Hello world')

    const result = project([
      start(A, 1),
      delta(A, 'Hello world'),
      message(A, committed),
      start(B, 1),
      delta(B, 'Sorry'),
      end('end', [committed]),
      delta(B, ', I cannot')
    ])

    expect(result.client.messages).toEqual([committed])
    expect(result.client.text).toBe('')
    expect(result.client.liveMessages).toEqual([])
    expectBothChats(result, ['Hello world'])
  })

  it('shows a committed answer once when a re-execution replays only the terminal event', () => {
    const committed = answer('Hello world')

    const result = project([
      start(A, 1),
      delta(A, 'Hello world'),
      message(A, committed),
      end('end', [committed]),
      end('end', [committed])
    ])

    expect(result.client.messages).toEqual([committed])
    expectBothChats(result, ['Hello world'])
  })

  it('drops a late start of an older turn, keeping the newer turn and its committed answer', () => {
    const checking = answer('Checking')
    const done = answer('Done!')

    const result = project([
      start(A, 1),
      delta(A, 'Checking'),
      message(A, checking),
      start('step-2:1', 2),
      start(B, 1),
      delta(B, 'stray'),
      delta('step-2:1', 'Done!'),
      message('step-2:1', done),
      end('end', [checking, done])
    ])

    expect(result.client.messages).toEqual([checking, done])
    expect(result.client.text).toBe('')
    expectBothChats(result, ['Checking', 'Done!'])
  })

  it('drops an execution that starts after its run ended', () => {
    const hello = answer('Hello')

    const result = project([
      start(A, 1),
      delta(A, 'Hello'),
      message(A, hello),
      end('end', [hello]),
      start(B, 1),
      delta(B, 'Sorry')
    ])

    expect(result.client.messages).toEqual([hello])
    expect(result.client.text).toBe('')
    expectBothChats(result, ['Hello'])
  })

  it("keeps a stopped run's answer when a later run reuses its turn numbers", () => {
    const partial = answer('Partial answer')

    const result = project([
      start(A, 1, 'run-1'),
      delta(A, 'Partial answer', 'run-1'),
      message(A, partial, 'run-1'),
      start('step-9:1', 1, 'run-2'),
      delta('step-9:1', 'Next', 'run-2')
    ])

    expect(result.client.liveMessages).toEqual([partial])
    expect(result.client.text).toBe('Next')
    expectBothChats(result, ['Partial answer', 'Next'])
  })

  it('restores a settled tool call whose id a superseded execution reused', () => {
    const call = ToolCall.make({ id: 'call_1', name: 'weather', params: {} })
    const turnOne = answer('Turn one', [call])
    const result0 = ToolResult.make({ toolCallId: call.id, content: '72F' })

    const result = project([
      start('step-0:1', 1),
      delta('step-0:1', 'Turn one'),
      live(identity => ToolInputEnd.make({ ...identity, call }), 'step-0:1'),
      message('step-0:1', turnOne),
      plain(identity => ToolExecutionStarted.make({ ...identity, call }), 'tool:0'),
      plain(
        identity => ToolExecutionCompleted.make({ ...identity, call, result: result0 }),
        'tool:1'
      ),
      start(A, 2),
      live(identity => ToolInputStart.make({ ...identity, id: call.id }), A),
      live(identity => ToolInputEnd.make({ ...identity, call }), A),
      start(B, 2),
      delta(B, 'Sorry')
    ])

    expect(result.client.toolRuns.map(run => run._tag)).toEqual(['Completed'])
    expectBothChats(result, ['Turn one | call_1:Completed', 'Sorry'])
  })

  it('shows the committed answer at a pause when the newer execution streamed', () => {
    const call = ToolCall.make({ id: 'call_1', name: 'question', params: {} })

    const request = QuestionRequest.make({
      requestId: 'question:call_1',
      toolCallId: call.id,
      call,
      questions: [QuestionPrompt.make({ id: 'choice', prompt: 'Pick one' })]
    })

    const asked = answer('Let me ask', [call])

    const result = project([
      start(A, 1),
      delta(A, 'Let me ask'),
      message(A, asked),
      start(B, 1),
      delta(B, 'Sorry'),
      plain(identity => QuestionRequested.make({ ...identity, request }), 'question'),
      plain(
        identity =>
          AgentAwaitingInput.make({
            ...identity,
            requests: [request],
            messages: [asked],
            turns: 1,
            usage: zeroAgentUsage
          }),
        'pause'
      )
    ])

    expect(result.client.messages).toEqual([asked])
    expect(result.client.text).toBe('')
    expectBothChats(result, ['Let me ask | call_1:QuestionRequested'])
  })

  it('keeps only identity once an execution settles', () => {
    const hello = answer('Hello')

    const result = project([start(A, 1), delta(A, 'Hello'), message(A, hello), end('end', [hello])])

    expect(result.client.executions).toEqual([
      {
        streamId: 'run-1',
        ended: true,
        closedThroughTurn: 0,
        retired: false,
        executions: [{ executionId: A, turn: 1, status: 'Settled', calls: [], output: [] }]
      }
    ])
  })

  it("restores an earlier turn's message that a superseded answer replaced by a reused call id", () => {
    const call = ToolCall.make({ id: 'call_1', name: 'weather', params: {} })
    const turnOne = answer('Turn one', [call])
    const result0 = ToolResult.make({ toolCallId: call.id, content: '72F' })

    const result = project([
      start('step-0:1', 1),
      delta('step-0:1', 'Turn one'),
      live(identity => ToolInputEnd.make({ ...identity, call }), 'step-0:1'),
      message('step-0:1', turnOne),
      plain(identity => ToolExecutionStarted.make({ ...identity, call }), 'tool:0'),
      plain(
        identity => ToolExecutionCompleted.make({ ...identity, call, result: result0 }),
        'tool:1'
      ),
      start(A, 2),
      message(A, answer('Wrong', [call])),
      start(B, 2),
      delta(B, 'Sorry')
    ])

    expect(result.client.liveMessages).toEqual([turnOne])
    expect(result.client.toolRuns.map(run => run._tag)).toEqual(['Completed'])
    expectBothChats(result, ['Turn one | call_1:Completed', 'Sorry'])
  })

  it.each(['pause', 'end'] as const)(
    'keeps a restored earlier-turn call in place when the committed answer reuses its id (%s)',
    terminal => {
      const call = ToolCall.make({ id: 'call_1', name: 'question', params: {} })
      const turnOne = answer('Turn one', [call])
      const result0 = ToolResult.make({ toolCallId: call.id, content: '72F' })
      const asked = answer('Asking', [call])

      const request = QuestionRequest.make({
        requestId: 'question:call_1',
        toolCallId: call.id,
        call,
        questions: [QuestionPrompt.make({ id: 'choice', prompt: 'Pick one' })]
      })

      const committed =
        terminal === 'pause'
          ? plain(
              identity =>
                AgentAwaitingInput.make({
                  ...identity,
                  requests: [request],
                  messages: [turnOne, asked],
                  turns: 2,
                  usage: zeroAgentUsage
                }),
              'pause'
            )
          : end('end', [turnOne, asked])

      const result = project([
        start('step-0:1', 1),
        delta('step-0:1', 'Turn one'),
        live(identity => ToolInputEnd.make({ ...identity, call }), 'step-0:1'),
        message('step-0:1', turnOne),
        plain(identity => ToolExecutionStarted.make({ ...identity, call }), 'tool:0'),
        plain(
          identity => ToolExecutionCompleted.make({ ...identity, call, result: result0 }),
          'tool:1'
        ),
        start(A, 2),
        delta(A, 'Asking'),
        message(A, asked),
        start(B, 2),
        live(identity => ToolInputStart.make({ ...identity, id: call.id }), B),
        delta(B, 'Sorry'),
        committed
      ])

      const expected =
        terminal === 'pause'
          ? ['Turn one | call_1:Completed', 'Asking | call_1:QuestionRequested']
          : ['Turn one | call_1:Completed', 'Asking | call_1:Called']

      expect(result.client.messages).toEqual([turnOne, asked])
      expect(result.client.text).toBe('')
      expectBothChats(result, expected)
    }
  )

  it('fences a run by its terminal event even when no execution of it was seen', () => {
    const hello = answer('Hello')

    const replayed = project([end('end', [hello]), start(B, 1), delta(B, 'Sorry')])

    expect(replayed.client.messages).toEqual([hello])
    expect(replayed.client.text).toBe('')
    expectBothChats(replayed, ['Hello'])

    const later = project([
      start(A, 1),
      delta(A, 'Hello'),
      message(A, hello),
      end('end', [hello]),
      start('step-2:1', 2),
      delta('step-2:1', 'More')
    ])

    expect(later.client.text).toBe('')
    expectBothChats(later, ['Hello'])
  })

  it('admits a retry of a turn after a user message: only terminal events close a turn', () => {
    const result = project([
      start(A, 1),
      delta(A, 'Hel'),
      plain(
        identity =>
          UserMessageEvent.make({ ...identity, message: UserMessage.make({ content: 'and?' }) }),
        'steer'
      ),
      start(B, 1),
      delta(B, 'Sorry')
    ])

    expect(result.client.text).toBe('Sorry')
    expect(shown(result.projection).at(-1)).toBe('Sorry')
    expect(shown(result.chat).at(-1)).toBe('Sorry')
  })

  it('starts a fresh run after AgentStart when a host reuses a stream id', () => {
    const next = answer('New answer')

    const result = project([
      plain(identity => AgentStart.make(identity), 'start-1'),
      start(A, 1),
      delta(A, 'Stopped par'),
      plain(identity => AgentStart.make(identity), 'start-2'),
      start(B, 1),
      delta(B, 'New answer'),
      message(B, next),
      end('end', [next])
    ])

    expect(result.client.messages).toEqual([next])
    expect(shown(result.projection).at(-1)).toBe('New answer')
    expect(shown(result.chat).at(-1)).toBe('New answer')
  })

  describe('a non-final turn that ran twice', () => {
    const lookup = ToolCall.make({ id: 'call_a', name: 'weather', params: { city: 'Oslo' } })
    const search = ToolCall.make({ id: 'call_b', name: 'search', params: { query: 'Oslo' } })
    const asking = ToolCall.make({ id: 'call_q', name: 'question', params: {} })
    // Distinct but equal instances: the terminal's messages arrive decoded apart from the events.
    const olderAnswer = () => answer('Checking the weather', [lookup])
    const newerAnswer = () => answer('Searching instead', [search])
    const done = answer('It is 12C in Oslo')
    const asked = answer('Celsius or Fahrenheit?', [asking])
    const weather = ToolResult.make({ toolCallId: lookup.id, content: '12C' })
    const found = ToolResult.make({ toolCallId: search.id, content: 'Oslo: 12C' })

    const request = QuestionRequest.make({
      requestId: 'question:call_q',
      toolCallId: asking.id,
      call: asking,
      questions: [QuestionPrompt.make({ id: 'unit', prompt: 'Pick one' })]
    })

    const inputEnd = (executionId: string, call: ToolCall) =>
      live(identity => ToolInputEnd.make({ ...identity, call }), executionId)

    const batch = (call: ToolCall, result: ToolResult) => ({
      started: plain(identity => ToolExecutionStarted.make({ ...identity, call }), `${call.id}:0`),
      completed: plain(
        identity => ToolExecutionCompleted.make({ ...identity, call, result }),
        `${call.id}:1`
      )
    })

    const finalTurn = (terminal: 'end' | 'pause', committed: ReadonlyArray<AgentMessage>) =>
      terminal === 'end'
        ? [
            start('step-2:1', 2),
            delta('step-2:1', 'It is 12C in Oslo'),
            message('step-2:1', done),
            end('end', [...committed, done])
          ]
        : [
            start('step-2:1', 2),
            delta('step-2:1', 'Celsius or Fahrenheit?'),
            live(identity => ToolInputEnd.make({ ...identity, call: asking }), 'step-2:1'),
            message('step-2:1', asked),
            plain(identity => QuestionRequested.make({ ...identity, request }), 'question'),
            plain(
              identity =>
                AgentAwaitingInput.make({
                  ...identity,
                  requests: [request],
                  messages: [...committed, asked],
                  turns: 2,
                  usage: zeroAgentUsage
                }),
              'pause'
            )
          ]

    const lastTurn = {
      end: 'It is 12C in Oslo',
      pause: 'Celsius or Fahrenheit? | call_q:QuestionRequested'
    }

    const olderRan = batch(lookup, weather)

    const interleavings = [
      'concurrent',
      'newer answers after the batch',
      'sequential',
      'newer silent'
    ] as const

    // The older execution committed: the tool batch ran its call while the newer one streamed.
    const olderCommitted: Record<(typeof interleavings)[number], ReadonlyArray<AgentEvent>> = {
      concurrent: [
        start(A, 1),
        delta(A, 'Checking the weather'),
        start(B, 1),
        delta(B, 'Searching instead'),
        inputEnd(A, lookup),
        message(A, olderAnswer()),
        inputEnd(B, search),
        olderRan.started,
        message(B, newerAnswer()),
        olderRan.completed
      ],
      'newer answers after the batch': [
        start(A, 1),
        delta(A, 'Checking the weather'),
        start(B, 1),
        inputEnd(A, lookup),
        message(A, olderAnswer()),
        delta(B, 'Searching instead'),
        olderRan.started,
        olderRan.completed,
        inputEnd(B, search),
        message(B, newerAnswer())
      ],
      sequential: [
        start(A, 1),
        delta(A, 'Checking the weather'),
        inputEnd(A, lookup),
        message(A, olderAnswer()),
        olderRan.started,
        start(B, 1),
        delta(B, 'Searching instead'),
        inputEnd(B, search),
        message(B, newerAnswer()),
        olderRan.completed
      ],
      'newer silent': [
        start(A, 1),
        delta(A, 'Checking the weather'),
        inputEnd(A, lookup),
        message(A, olderAnswer()),
        start(B, 1),
        olderRan.started,
        olderRan.completed
      ]
    }

    describe.each(['end', 'pause'] as const)('at %s', terminal => {
      it.each(interleavings)(
        'shows the older committed answer and the calls the batch ran (%s)',
        interleaving => {
          const committed = [
            olderAnswer(),
            ToolResultMessage.make({ toolCallId: lookup.id, content: weather.content })
          ]

          const result = project([
            ...olderCommitted[interleaving],
            ...finalTurn(terminal, committed)
          ])

          expect(result.client.messages).toEqual([...committed, terminal === 'end' ? done : asked])

          expect(result.client.liveMessages).toEqual([])
          expect(result.client.text).toBe('')

          expect(
            result.client.toolRuns.map(run =>
              Predicate.isTagged(run, 'QuestionRequested')
                ? `${run.request.toolCallId}:${run._tag}`
                : `${'call' in run ? run.call.id : ''}:${run._tag}`
            )
          ).toEqual(
            terminal === 'end'
              ? ['call_a:Completed']
              : ['call_a:Completed', 'call_q:QuestionRequested']
          )

          expectBothChats(result, ['Checking the weather | call_a:Completed', lastTurn[terminal]])
        }
      )

      it('keeps the newer answer when the newer execution committed', () => {
        const newerRan = batch(search, found)

        const committed = [
          newerAnswer(),
          ToolResultMessage.make({ toolCallId: search.id, content: found.content })
        ]

        const result = project([
          start(A, 1),
          delta(A, 'Checking the weather'),
          inputEnd(A, lookup),
          message(A, olderAnswer()),
          start(B, 1),
          delta(B, 'Searching instead'),
          inputEnd(B, search),
          message(B, newerAnswer()),
          newerRan.started,
          newerRan.completed,
          ...finalTurn(terminal, committed)
        ])

        expect(result.client.messages).toEqual([...committed, terminal === 'end' ? done : asked])
        expectBothChats(result, ['Searching instead | call_b:Completed', lastTurn[terminal]])
      })
    })

    describe('reach of the reconcile', () => {
      const committedTurn = () => [
        olderAnswer(),
        ToolResultMessage.make({ toolCallId: lookup.id, content: weather.content })
      ]

      const runs = (state: ReturnType<typeof project>['client']) =>
        state.toolRuns.map(run =>
          Predicate.isTagged(run, 'QuestionRequested')
            ? `${run.request.toolCallId}:${run._tag}`
            : `${'call' in run ? run.call.id : ''}:${run._tag}`
        )

      it.each(['end', 'pause'] as const)(
        "keeps a later turn's answer that reuses the shown answer's call id (%s)",
        terminal => {
          // A provider that numbers calls per response reuses `call_b` in the next turn.
          const reused = ToolCall.make({ id: 'call_b', name: 'question', params: {} })
          const reusing = answer('Which unit?', [reused])

          const reusedRequest = QuestionRequest.make({
            requestId: 'question:call_b',
            toolCallId: reused.id,
            call: reused,
            questions: [QuestionPrompt.make({ id: 'unit', prompt: 'Pick one' })]
          })

          const messages = [...committedTurn(), reusing]

          const result = project([
            ...olderCommitted.sequential,
            start('step-2:1', 2),
            message('step-2:1', reusing),
            ...(terminal === 'end'
              ? [end('end', messages)]
              : [
                  plain(
                    identity => QuestionRequested.make({ ...identity, request: reusedRequest }),
                    'question-b'
                  ),
                  plain(
                    identity =>
                      AgentAwaitingInput.make({
                        ...identity,
                        requests: [reusedRequest],
                        messages,
                        turns: 2,
                        usage: zeroAgentUsage
                      }),
                    'pause'
                  )
                ])
          ])

          expect(result.client.messages).toEqual(messages)
          expect(result.client.liveMessages).toEqual([])

          expect(runs(result.client)).toEqual(
            terminal === 'end'
              ? ['call_a:Completed']
              : ['call_a:Completed', 'call_b:QuestionRequested']
          )

          expectBothChats(result, [
            'Checking the weather | call_a:Completed',
            terminal === 'end'
              ? 'Which unit? | call_b:Called'
              : 'Which unit? | call_b:QuestionRequested'
          ])
        }
      )

      it("keeps a later turn's call that reuses an id of the shown answer", () => {
        const reused = ToolCall.make({ id: 'call_b', name: 'search', params: { query: 'Bergen' } })
        const looking = answer('Looking it up', [reused])
        const bergen = ToolResult.make({ toolCallId: reused.id, content: 'Bergen: 9C' })
        const ran = batch(reused, bergen)

        const messages = [
          ...committedTurn(),
          looking,
          ToolResultMessage.make({ toolCallId: reused.id, content: bergen.content }),
          done
        ]

        const result = project([
          ...olderCommitted.sequential,
          start('step-2:1', 2),
          delta('step-2:1', 'Looking it up'),
          inputEnd('step-2:1', reused),
          message('step-2:1', looking),
          ran.started,
          ran.completed,
          start('step-3:1', 3),
          delta('step-3:1', 'It is 12C in Oslo'),
          message('step-3:1', done),
          end('end', messages)
        ])

        expect(result.client.messages).toEqual(messages)
        expect(runs(result.client)).toEqual(['call_a:Completed', 'call_b:Completed'])

        expectBothChats(result, [
          'Checking the weather | call_a:Completed',
          'Looking it up | call_b:Completed',
          'It is 12C in Oslo'
        ])
      })

      it('puts the committed answer before a user message that followed the turn', () => {
        const steer = UserMessage.make({ content: 'And Bergen?' })

        const result = project([
          ...olderCommitted.sequential,
          plain(identity => UserMessageEvent.make({ ...identity, message: steer }), 'steer'),
          ...finalTurn('end', [...committedTurn(), steer])
        ])

        expect(result.client.messages).toEqual([...committedTurn(), steer, done])

        const transcript = (messages: ReadonlyArray<AgentChatMessage>) =>
          messages.map(chatMessage => `${chatMessage.role}: ${describeParts(chatMessage)}`)

        const expected = [
          'assistant: Checking the weather | call_a:Completed',
          'user: And Bergen?',
          'assistant: It is 12C in Oslo'
        ]

        expect(transcript(result.projection)).toEqual(expected)
        expect(transcript(result.chat)).toEqual(expected)
      })

      it("keeps a later turn's call with an id of the committed answer in its turn", () => {
        const searched = ToolCall.make({ id: 'srv_1', name: 'web_search', params: {} })
        const searchedResult = ToolResult.make({ toolCallId: searched.id, content: 'Oslo' })

        const olderSearching = () =>
          AssistantAgentMessage.make({
            parts: [
              AssistantTextPart.make({ content: 'Checking the weather' }),
              ProviderToolCallPart.make({ call: searched }),
              HostToolCallPart.make({ call: lookup })
            ]
          })

        const doneSearching = AssistantAgentMessage.make({
          parts: [
            AssistantTextPart.make({ content: 'It is 12C in Oslo' }),
            ProviderToolCallPart.make({ call: searched })
          ]
        })

        const messages = [
          olderSearching(),
          ToolResultMessage.make({ toolCallId: lookup.id, content: weather.content }),
          doneSearching
        ]

        const result = project([
          start(A, 1),
          delta(A, 'Checking the weather'),
          inputEnd(A, lookup),
          message(A, olderSearching()),
          olderRan.started,
          start(B, 1),
          delta(B, 'Searching instead'),
          inputEnd(B, search),
          message(B, newerAnswer()),
          olderRan.completed,
          start('step-2:1', 2),
          delta('step-2:1', 'It is 12C in Oslo'),
          live(
            identity =>
              ProviderToolResult.make({ ...identity, call: searched, result: searchedResult }),
            'step-2:1'
          ),
          message('step-2:1', doneSearching),
          end('end', messages)
        ])

        expect(result.client.messages).toEqual(messages)

        expectBothChats(result, [
          'Checking the weather | srv_1:Called | call_a:Completed',
          'It is 12C in Oslo | srv_1:ProviderCompleted'
        ])
      })

      it('shows the committed answer when the message its turn followed is gone', () => {
        const question = UserMessage.make({ content: 'Weather in Oslo?' })

        const asking = plain(
          identity => UserMessageEvent.make({ ...identity, message: question }),
          'q'
        )

        const terminal = end('end', [...committedTurn(), done])

        const before = [
          asking,
          ...olderCommitted.sequential,
          start('step-2:1', 2),
          delta('step-2:1', 'It is 12C in Oslo'),
          message('step-2:1', done)
        ]

        // A host removed the message the turn's output followed (here: the user message).
        const withoutQuestion = (messages: ReadonlyArray<AgentChatMessage>) =>
          messages.filter(chatMessage => chatMessage.role !== 'user')

        const projected = before.reduce(
          (state, event) => applyAgentEventToChatProjection(state, event),
          makeAgentChatEventProjectionState()
        )

        const reduced = before.reduce(
          (state, event) => reduceAgentChatState(state, AgentChatAction.Event({ event })),
          initialAgentChatState
        )

        const expected = ['Checking the weather | call_a:Completed', 'It is 12C in Oslo']

        expect(
          shown(
            applyAgentEventToChatProjection(
              { ...projected, chatMessages: withoutQuestion(projected.chatMessages) },
              terminal
            ).chatMessages
          )
        ).toEqual(expected)

        expect(
          shown(
            reduceAgentChatState(
              { ...reduced, chatMessages: withoutQuestion(reduced.chatMessages) },
              AgentChatAction.Event({ event: terminal })
            ).chatMessages
          )
        ).toEqual(expected)
      })
    })
  })

  it('keeps events without an execution on the plain path', () => {
    const result = project([
      plain(identity => LLMStreamStart.make({ ...identity, turn: 1 }), '0'),
      plain(identity => LLMTextDelta.make({ ...identity, text: 'Hel' }), '1'),
      plain(identity => LLMStreamStart.make({ ...identity, turn: 1 }), '2'),
      plain(identity => LLMTextDelta.make({ ...identity, text: 'Sorry' }), '3')
    ])

    expect(result.client.text).toBe('Sorry')
    expect(result.client.executions ?? []).toEqual([])
    expectBothChats(result, ['Sorry'])
  })
})

// Providers that number calls per response reuse `call_0` in every turn (and in every execution of
// a turn): a turn's events match a call only after its turn's start, never an earlier turn's call.
describe('call ids reused across turns', () => {
  const weather = (city: string) =>
    ToolCall.make({ id: 'call_0', name: 'weather', params: { city } })

  const oslo = weather('Oslo')
  const bergen = weather('Bergen')
  const paris = weather('Paris')
  const lyon = ToolCall.make({ id: 'call_1', name: 'weather', params: { city: 'Lyon' } })
  const result = (content: string) => ToolResult.make({ toolCallId: 'call_0', content })

  const resultMessage = (content: string) =>
    ToolResultMessage.make({ toolCallId: 'call_0', content })

  const describeCalls = (chatMessage: AgentChatMessage) =>
    chatMessage.parts
      .flatMap(part => {
        if (Predicate.isTagged(part, 'Text')) return [part.content]

        if (Predicate.isTagged(part, 'ToolCall')) {
          return [`${part.call.id} ${JSON.stringify(part.call.params)}:${part.state._tag}`]
        }

        return []
      })
      .join(' | ')

  /** Per assistant chat message: its text, and its tool calls as `id params:state`. */
  const calls = (messages: ReadonlyArray<AgentChatMessage>) =>
    messages.flatMap(chatMessage =>
      chatMessage.role !== 'assistant' ? [] : [describeCalls(chatMessage)]
    )

  const expectChats = (result: ReturnType<typeof project>, expected: ReadonlyArray<string>) => {
    expect(calls(result.projection)).toEqual(expected)
    expect(calls(result.chat)).toEqual(expected)
  }

  type Tagging = 'tagged' | 'plain'

  /** One model turn: its start, text, the call's input stream and its `AssistantMessage`. */
  const modelTurn = (
    tagging: Tagging,
    executionId: string,
    turn: number,
    value: AssistantAgentMessage,
    call?: ToolCall
  ): ReadonlyArray<AgentEvent> => {
    const event = <Event extends AgentEvent>(make: (identity: PlainIdentity) => Event) =>
      tagging === 'tagged'
        ? live(make, executionId)
        : plain(make, `${executionId}:${(sequence += 1)}`)

    const text = value.parts
      .flatMap(part =>
        Predicate.isTagged(part, 'Text') && Predicate.isString(part.content) ? [part.content] : []
      )
      .join('')

    return [
      event(identity => LLMStreamStart.make({ ...identity, turn })),
      ...(text === '' ? [] : [event(identity => LLMTextDelta.make({ ...identity, text }))]),
      ...(call === undefined
        ? []
        : [
            event(identity => ToolInputStart.make({ ...identity, id: call.id, name: call.name })),
            event(identity =>
              ToolInputDelta.make({ ...identity, id: call.id, delta: JSON.stringify(call.params) })
            ),
            event(identity => ToolInputEnd.make({ ...identity, call }))
          ]),
      event(identity => AssistantMessageEvent.make({ ...identity, message: value }))
    ]
  }

  /** The tool batch running a call (host events, no execution). */
  const ran = (call: ToolCall, value: ToolResult) => {
    const id = `${JSON.stringify(call.params)}:${(sequence += 1)}`

    return {
      started: plain(identity => ToolExecutionStarted.make({ ...identity, call }), `${id}:started`),
      completed: plain(
        identity => ToolExecutionCompleted.make({ ...identity, call, result: value }),
        `${id}:completed`
      )
    }
  }

  const batch = (call: ToolCall, value: ToolResult) => {
    const run = ran(call, value)

    return [run.started, run.completed]
  }

  const turnOne = answer('Oslo first', [oslo])

  const firstTurn = (tagging: Tagging) => [
    ...modelTurn(tagging, 'model-1:1', 1, turnOne, oslo),
    ...batch(oslo, result('12C'))
  ]

  const userMessage = (content: string, id: string) =>
    plain(
      identity => UserMessageEvent.make({ ...identity, message: UserMessage.make({ content }) }),
      id
    )

  it.each(['tagged', 'plain'] as const)(
    "keeps an earlier turn's completed call when a later turn reuses its id (%s)",
    tagging => {
      const turnTwo = answer('Now Bergen', [bergen])
      const done = answer('Oslo 12C, Bergen 9C')

      const messages = [turnOne, resultMessage('12C'), turnTwo, resultMessage('9C'), done]

      const events = [
        ...firstTurn(tagging),
        ...modelTurn(tagging, 'model-2:1', 2, turnTwo, bergen),
        ...batch(bergen, result('9C')),
        ...modelTurn(tagging, 'model-3:1', 3, done),
        end('end', messages)
      ]

      const expected = [
        'Oslo first | call_0 {"city":"Oslo"}:Completed',
        'Now Bergen | call_0 {"city":"Bergen"}:Completed',
        'Oslo 12C, Bergen 9C'
      ]

      expectChats(project(events.slice(0, -1)), expected)

      const ended = project(events)

      expectChats(ended, expected)
      expect(ended.client.messages).toEqual(messages)
      // The client state keeps each turn's tool run (`test/client/tool-run-turns.test.ts`).
      expect(ended.client.toolRuns).toMatchObject([
        { _tag: 'Completed', call: oslo },
        { _tag: 'Completed', call: bergen }
      ])
    }
  )

  it('keeps one call when an untagged step of a later turn runs again', () => {
    // A redelivered step without `executionId` repeats the call: the turn keeps its start.
    const turnTwo = AssistantAgentMessage.make({ parts: [HostToolCallPart.make({ call: bergen })] })

    const result_ = project([
      ...firstTurn('plain'),
      plain(identity => LLMStreamStart.make({ ...identity, turn: 2 }), 'first-attempt'),
      plain(identity => ToolInputEnd.make({ ...identity, call: bergen }), 'first-attempt:call'),
      ...modelTurn('plain', 'model-2:2', 2, turnTwo, bergen),
      ...batch(bergen, result('9C'))
    ])

    expectChats(result_, [
      'Oslo first | call_0 {"city":"Oslo"}:Completed',
      'call_0 {"city":"Bergen"}:Completed'
    ])
  })

  describe('host events for an earlier turn', () => {
    const exporting = ToolCall.make({ id: 'call_0', name: 'export', params: { format: 'csv' } })

    const accepted = makeBackgroundToolAcceptedResult({
      toolCallId: exporting.id,
      acceptance: BackgroundToolAccepted.make({ version: 1, executionId: 'owner:export' })
    })

    const startedExport = answer('Starting the export', [exporting])
    const working = answer('Working on it')

    const reduceChat = (events: ReadonlyArray<AgentEvent>, initial = initialAgentChatState) =>
      events.reduce(
        (state, event) => reduceAgentChatState(state, AgentChatAction.Event({ event })),
        initial
      )

    const reduceProjection = (events: ReadonlyArray<AgentEvent>) =>
      events.reduce(
        (state, event) => applyAgentEventToChatProjection(state, event),
        makeAgentChatEventProjectionState()
      )

    it('keeps one settled part when a later turn sees a replayed start of its call', () => {
      const events = [
        ...modelTurn('tagged', 'model-1:1', 1, startedExport, exporting),
        plain(identity => ToolExecutionStarted.make({ ...identity, call: exporting }), 'export:0'),
        plain(
          identity =>
            ToolExecutionAccepted.make({ ...identity, call: exporting, result: accepted }),
          'export:1'
        ),
        ...modelTurn('tagged', 'model-2:1', 2, working)
      ]

      // A replay without event id of the turn-1 call's start.
      const replayed = ToolExecutionStarted.make({ call: exporting })
      const expected = ['Starting the export | call_0 {"format":"csv"}:Accepted', 'Working on it']

      const chat = reduceChat(events)
      const replayedChat = reduceChat([replayed], chat)

      expect(calls(replayedChat.chatMessages)).toEqual(expected)
      expect(replayedChat.status).toEqual(chat.status)

      expect(
        calls(applyAgentEventToChatProjection(reduceProjection(events), replayed).chatMessages)
      ).toEqual(expected)
    })

    it("completes an earlier turn's call when its batch event arrives after the next start", () => {
      const lookup = ran(oslo, result('12C'))

      const result_ = project([
        ...modelTurn('tagged', 'model-1:1', 1, turnOne, oslo),
        lookup.started,
        ...modelTurn('tagged', 'model-2:1', 2, working),
        lookup.completed
      ])

      expectChats(result_, ['Oslo first | call_0 {"city":"Oslo"}:Completed', 'Working on it'])
    })

    it("adds a later turn's call the batch ran when an earlier turn holds another call with its id", () => {
      // The older execution's call, unacknowledged when the newer one started, was removed; the
      // tool batch runs it anyway: it is a call of its own, not a replay of turn 1's.
      const bergenRan = ran(bergen, result('9C'))
      const turnTwo = () => answer('Now Bergen', [bergen])

      const result_ = project([
        ...firstTurn('tagged'),
        start(A, 2),
        delta(A, 'Now Bergen'),
        live(identity => ToolInputEnd.make({ ...identity, call: bergen }), A),
        message(A, turnTwo()),
        start(B, 2),
        bergenRan.started,
        bergenRan.completed,
        end('end', [turnOne, resultMessage('12C'), turnTwo(), resultMessage('9C')])
      ])

      expectChats(result_, [
        'Oslo first | call_0 {"city":"Oslo"}:Completed',
        'Now Bergen | call_0 {"city":"Bergen"}:Completed'
      ])
    })

    const twoTurns = [
      ...firstTurn('tagged'),
      ...modelTurn('tagged', 'model-2:1', 2, answer('Now Bergen', [bergen]), bergen),
      ...batch(bergen, result('9C')),
      ...modelTurn('tagged', 'model-3:1', 3, working)
    ]

    it('keeps one part when a replayed start names a call two turns back', () => {
      // Turn 2 reused `call_0`; the replay names turn 1's call.
      const replayed = ToolExecutionStarted.make({ call: oslo })

      const expected = [
        'Oslo first | call_0 {"city":"Oslo"}:Completed',
        'Now Bergen | call_0 {"city":"Bergen"}:Completed',
        'Working on it'
      ]

      const chat = reduceChat(twoTurns)
      const replayedChat = reduceChat([replayed], chat)

      expect(calls(replayedChat.chatMessages)).toEqual(expected)
      expect(replayedChat.status).toEqual(chat.status)

      expect(
        calls(applyAgentEventToChatProjection(reduceProjection(twoTurns), replayed).chatMessages)
      ).toEqual(expected)
    })

    describe('a replayed answer to an earlier turn', () => {
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

      const approval = ToolApprovalRequest.make({
        requestId: 'approval:call_0',
        toolCallId: 'call_0',
        call: oslo
      })

      const denied = ToolApprovalResponse.make({
        requestId: approval.requestId,
        toolCallId: 'call_0',
        decision: 'denied',
        source: 'user'
      })

      const asks = {
        question: {
          message: answer('Which unit?', [unit]),
          call: unit,
          requested: plain(
            identity => QuestionRequested.make({ ...identity, request: question }),
            'question'
          ),
          answer: (identity: Partial<PlainIdentity>): AgentEvent =>
            QuestionAnswered.make({ ...identity, response: answered }),
          shown: 'Which unit? | call_0 {"city":"Oslo"}:QuestionAnswered'
        },
        approval: {
          message: answer('Oslo needs approval', [oslo]),
          call: oslo,
          requested: plain(
            identity => ToolApprovalRequested.make({ ...identity, call: oslo, request: approval }),
            'approval'
          ),
          answer: (identity: Partial<PlainIdentity>): AgentEvent =>
            ToolApprovalDenied.make({
              ...identity,
              toolCallId: 'call_0',
              reason: 'No',
              response: denied
            }),
          shown: 'Oslo needs approval | call_0 {"city":"Oslo"}:Denied'
        }
      }

      it.each(['question', 'approval'] as const)(
        "leaves a later turn's call with the id alone (%s)",
        kind => {
          const ask = asks[kind]

          const events = [
            ...modelTurn('tagged', 'model-1:1', 1, ask.message, ask.call),
            ask.requested,
            plain(ask.answer, 'answer'),
            ...modelTurn('tagged', 'model-2:1', 2, answer('Now Bergen', [bergen]), bergen),
            ...batch(bergen, result('9C')),
            ...modelTurn('tagged', 'model-3:1', 3, working)
          ]

          // The answer again, without event id.
          const replayed = ask.answer({})

          const expected = [
            ask.shown,
            'Now Bergen | call_0 {"city":"Bergen"}:Completed',
            'Working on it'
          ]

          expect(calls(reduceChat([replayed], reduceChat(events)).chatMessages)).toEqual(expected)

          expect(
            calls(applyAgentEventToChatProjection(reduceProjection(events), replayed).chatMessages)
          ).toEqual(expected)
        }
      )

      it.each(['question', 'approval'] as const)(
        "keeps one answered card when an earlier turn's request is replayed (%s)",
        kind => {
          const ask = asks[kind]

          const events = [
            ...modelTurn('tagged', 'model-1:1', 1, ask.message, ask.call),
            ask.requested,
            plain(ask.answer, 'answer'),
            ...modelTurn('tagged', 'model-2:1', 2, working)
          ]

          const replayed =
            kind === 'question'
              ? QuestionRequested.make({ request: question })
              : ToolApprovalRequested.make({ call: oslo, request: approval })

          // The replay lands on the earlier turn's call: it never adds a second card, and the
          // answered call stays answered (#346).
          const expected = [ask.shown, 'Working on it']

          expect(calls(reduceChat([replayed], reduceChat(events)).chatMessages)).toEqual(expected)

          expect(
            calls(applyAgentEventToChatProjection(reduceProjection(events), replayed).chatMessages)
          ).toEqual(expected)
        }
      )
    })

    it('settles only the latest call with its id when a result message is added', () => {
      const events = [
        ...firstTurn('tagged'),
        ...modelTurn('tagged', 'model-2:1', 2, startedExport, exporting)
      ]

      const acknowledged = ToolResultMessage.make({
        toolCallId: exporting.id,
        content: accepted.content,
        acceptance: accepted.acceptance
      })

      const expected = [
        'Oslo first | call_0 {"city":"Oslo"}:Completed',
        'Starting the export | call_0 {"format":"csv"}:Accepted'
      ]

      const chat = reduceChat(events)

      expect(
        calls(
          reduceAgentChatState(chat, AgentChatAction.AppendMessage({ message: acknowledged }))
            .chatMessages
        )
      ).toEqual(expected)

      expect(
        calls(
          reduceAgentChatState(chat, AgentChatAction.HydrateMessage({ message: acknowledged }))
            .chatMessages
        )
      ).toEqual(expected)

      // Hosts merging settled results into a projection (`appendProtocolMessage`).
      expect(
        calls(appendProtocolMessage(reduceProjection(events).chatMessages, acknowledged))
      ).toEqual(expected)
    })
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

    const unit = ToolCall.make({ id: 'call_0', name: 'question', params: { city: 'Bergen' } })

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

    const asks = {
      approval: {
        message: answer('Bergen needs approval', [bergen]),
        call: bergen,
        request: approval,
        response: approved,
        requested: plain(
          identity => ToolApprovalRequested.make({ ...identity, call: bergen, request: approval }),
          'approval'
        ),
        // The resumed tool batch runs the paused call before the next turn starts.
        resumed: [
          plain(
            identity =>
              ToolApprovalGranted.make({ ...identity, toolCallId: 'call_0', response: approved }),
            'granted'
          ),
          ...batch(bergen, result('9C'))
        ],
        shown: 'Bergen needs approval | call_0 {"city":"Bergen"}:Completed'
      },
      question: {
        message: answer('Which unit for Bergen?', [unit]),
        call: unit,
        request: question,
        response: answered,
        requested: plain(
          identity => QuestionRequested.make({ ...identity, request: question }),
          'question'
        ),
        resumed: [
          plain(identity => QuestionAnswered.make({ ...identity, response: answered }), 'answered')
        ],
        shown: 'Which unit for Bergen? | call_0 {"city":"Bergen"}:QuestionAnswered'
      }
    }

    describe.each(['approval', 'question'] as const)('%s', kind => {
      const ask = asks[kind]
      const done = answer('Bergen is 9C')

      const paused = (tagging: Tagging) => [
        ...firstTurn(tagging),
        ...modelTurn(tagging, 'model-2:1', 2, ask.message, ask.call),
        ask.requested,
        plain(
          identity =>
            AgentAwaitingInput.make({
              ...identity,
              requests: [ask.request],
              messages: [turnOne, resultMessage('12C'), ask.message],
              turns: 2,
              usage: zeroAgentUsage
            }),
          'pause'
        )
      ]

      const resumed = (tagging: Tagging) => [
        ...ask.resumed,
        ...modelTurn(tagging, 'model-3:1', 3, done),
        end('end', [done])
      ]

      const expected = ['Oslo first | call_0 {"city":"Oslo"}:Completed', ask.shown, 'Bergen is 9C']

      it.each(['tagged', 'plain'] as const)(
        "acts on the paused call, not an earlier turn's call with its id (%s)",
        tagging => {
          expectChats(project([...paused(tagging), ...resumed(tagging)]), expected)
        }
      )

      it.each(['tagged', 'plain'] as const)(
        'acts on the paused call after a local answer (%s)',
        tagging => {
          const pausedState = paused(tagging).reduce(
            (state, event) => reduceAgentChatState(state, AgentChatAction.Event({ event })),
            initialAgentChatState
          )

          const answeredState = reduceAgentChatState(
            pausedState,
            AgentChatAction.SubmitHitlResponse({ response: ask.response })
          )

          const final = resumed(tagging).reduce(
            (state, event) => reduceAgentChatState(state, AgentChatAction.Event({ event })),
            answeredState
          )

          expect(calls(final.chatMessages)).toEqual(expected)
        }
      )
    })
  })

  describe('with a turn that ran twice', () => {
    const turnTwo = () => answer('Now Bergen', [bergen])
    const bergenRan = ran(bergen, result('9C'))

    // Turn 2's older execution commits `call_0`; the newer one reuses the id for another call.
    const disputed = [
      start(A, 2),
      delta(A, 'Now Bergen'),
      live(identity => ToolInputEnd.make({ ...identity, call: bergen }), A),
      message(A, turnTwo()),
      bergenRan.started,
      start(B, 2),
      message(B, answer('Lyon instead', [weather('Lyon')])),
      bergenRan.completed
    ]

    it("keeps every turn's call when a disputed turn between them reuses the id", () => {
      const turnThree = answer('And Paris', [paris])
      const done = answer('All done')

      const messages = [
        turnOne,
        resultMessage('12C'),
        turnTwo(),
        resultMessage('9C'),
        turnThree,
        resultMessage('15C'),
        done
      ]

      const result_ = project([
        ...firstTurn('tagged'),
        ...disputed,
        ...modelTurn('tagged', 'model-3:1', 3, turnThree, paris),
        ...batch(paris, result('15C')),
        ...modelTurn('tagged', 'model-4:1', 4, done),
        end('end', messages)
      ])

      expect(result_.client.messages).toEqual(messages)

      expectChats(result_, [
        'Oslo first | call_0 {"city":"Oslo"}:Completed',
        'Now Bergen | call_0 {"city":"Bergen"}:Completed',
        'And Paris | call_0 {"city":"Paris"}:Completed',
        'All done'
      ])
    })

    it("discards the newer answer before a steer when the turn's anchor is gone", () => {
      const done = answer('Bergen is 9C')

      const before = [
        userMessage('Weather in Oslo, then Bergen?', 'question'),
        ...firstTurn('tagged'),
        start(A, 2),
        delta(A, 'Now Bergen'),
        live(identity => ToolInputEnd.make({ ...identity, call: bergen }), A),
        message(A, turnTwo()),
        bergenRan.started,
        start(B, 2),
        delta(B, 'Lyon instead'),
        live(identity => ToolInputEnd.make({ ...identity, call: lyon }), B),
        message(B, answer('Lyon instead', [lyon])),
        bergenRan.completed,
        userMessage('Thanks', 'steer'),
        ...modelTurn('tagged', 'model-3:1', 3, done)
      ]

      const terminal = end('end', [turnOne, resultMessage('12C'), turnTwo(), resultMessage('9C')])

      // A host removed turn 2's anchor, the message its output followed (turn 1's answer).
      const withoutTurnOne = (messages: ReadonlyArray<AgentChatMessage>) =>
        messages.filter(chatMessage => !describeCalls(chatMessage).startsWith('Oslo first'))

      const transcript = (messages: ReadonlyArray<AgentChatMessage>) =>
        messages.map(chatMessage => `${chatMessage.role}: ${describeCalls(chatMessage)}`)

      const projected = before.reduce(
        (state, event) => applyAgentEventToChatProjection(state, event),
        makeAgentChatEventProjectionState()
      )

      const reduced = before.reduce(
        (state, event) => reduceAgentChatState(state, AgentChatAction.Event({ event })),
        initialAgentChatState
      )

      const expected = [
        'user: Weather in Oslo, then Bergen?',
        'assistant: Now Bergen | call_0 {"city":"Bergen"}:Completed',
        'user: Thanks',
        'assistant: Bergen is 9C'
      ]

      expect(
        transcript(
          applyAgentEventToChatProjection(
            { ...projected, chatMessages: withoutTurnOne(projected.chatMessages) },
            terminal
          ).chatMessages
        )
      ).toEqual(expected)

      expect(
        transcript(
          reduceAgentChatState(
            { ...reduced, chatMessages: withoutTurnOne(reduced.chatMessages) },
            AgentChatAction.Event({ event: terminal })
          ).chatMessages
        )
      ).toEqual(expected)
    })

    it.each([1, 2])(
      "keeps a later turn's call when that turn's start carried no execution (%i later turns)",
      laterTurns => {
        const searched = ToolCall.make({ id: 'srv_0', name: 'web_search', params: {} })
        const found = ToolResult.make({ toolCallId: searched.id, content: 'Bergen' })

        const searching = () =>
          AssistantAgentMessage.make({
            parts: [
              AssistantTextPart.make({ content: 'Now Bergen' }),
              ProviderToolCallPart.make({ call: searched }),
              HostToolCallPart.make({ call: bergen })
            ]
          })

        const doneSearching = AssistantAgentMessage.make({
          parts: [
            AssistantTextPart.make({ content: 'Bergen is 9C' }),
            ProviderToolCallPart.make({ call: searched })
          ]
        })

        const thanks = answer('Anything else?')
        const turnFour = laterTurns === 2 ? [thanks] : []

        const messages = [
          turnOne,
          resultMessage('12C'),
          searching(),
          resultMessage('9C'),
          doneSearching,
          ...turnFour
        ]

        const result_ = project([
          ...firstTurn('tagged'),
          start(A, 2),
          delta(A, 'Now Bergen'),
          live(identity => ToolInputEnd.make({ ...identity, call: bergen }), A),
          message(A, searching()),
          bergenRan.started,
          start(B, 2),
          delta(B, 'Lyon instead'),
          message(B, answer('Lyon instead', [lyon])),
          bergenRan.completed,
          // Turn 3's events carry no `executionId`: its untagged start records turn 2's `Until`.
          plain(identity => LLMStreamStart.make({ ...identity, turn: 3 }), 'turn-3:start'),
          plain(
            identity => LLMTextDelta.make({ ...identity, text: 'Bergen is 9C' }),
            'turn-3:text'
          ),
          plain(
            identity => ProviderToolResult.make({ ...identity, call: searched, result: found }),
            'turn-3:search'
          ),
          plain(
            identity => AssistantMessageEvent.make({ ...identity, message: doneSearching }),
            'turn-3:message'
          ),
          // A later untagged turn moves the latest start on; turn 2 still ends where turn 3 began.
          ...(laterTurns === 2 ? modelTurn('plain', 'model-4:1', 4, thanks) : []),
          end('end', messages)
        ])

        expect(result_.client.messages).toEqual(messages)

        expectChats(result_, [
          'Oslo first | call_0 {"city":"Oslo"}:Completed',
          'Now Bergen | srv_0 {}:Called | call_0 {"city":"Bergen"}:Completed',
          'Bergen is 9C | srv_0 {}:ProviderCompleted',
          ...(laterTurns === 2 ? ['Anything else?'] : [])
        ])
      }
    )
  })
})

describe('a start the client missed', () => {
  const missed = (event: AgentEvent, runs: AgentExecutions<never> = []) =>
    missedAgentExecutionStart(runs, event)

  const named = { executionId: 'step-2:1', executionTurn: 2, streamId: 'run-1' }

  it('is the start of an unseen execution that names its turn, without an event id', () => {
    const start = missed(
      LLMTextDelta.make({ ...named, eventId: 'run-1:2:5:step-2:1', createdAtMs: 7, text: 'Hej' })
    )

    expect(start).toEqual(
      LLMStreamStart.make({ turn: 2, executionId: 'step-2:1', streamId: 'run-1', createdAtMs: 7 })
    )
    expect(start?.eventId).toBeUndefined()
  })

  it('is nothing for a known execution, a start, a turn start, or an event without both fields', () => {
    const known: AgentExecutions<never> = [
      {
        streamId: 'run-1',
        ended: false,
        closedThroughTurn: 0,
        retired: false,
        executions: [{ executionId: 'step-2:1', turn: 2, status: 'Settled', calls: [], output: [] }]
      }
    ]

    expect(missed(LLMTextDelta.make({ ...named, text: 'Hej' }), known)).toBeUndefined()
    expect(missed(LLMStreamStart.make({ ...named, turn: 2 }))).toBeUndefined()
    expect(missed(TurnStart.make({ ...named, turn: 2 }))).toBeUndefined()
    expect(missed(LLMTextDelta.make({ executionId: 'step-2:1', text: 'Hej' }))).toBeUndefined()
    expect(missed(LLMTextDelta.make({ executionTurn: 2, text: 'Hej' }))).toBeUndefined()
  })
})
