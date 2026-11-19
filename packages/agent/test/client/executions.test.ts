import { describe, expect, it } from '@effect/vitest'
import { Predicate } from 'effect'
import {
  AgentAwaitingInput,
  AgentEnd,
  AgentStart,
  AssistantAgentMessage,
  AssistantMessageEvent,
  AssistantTextPart,
  HostToolCallPart,
  LLMStreamStart,
  LLMTextDelta,
  QuestionPrompt,
  QuestionRequest,
  QuestionRequested,
  ToolCall,
  ToolExecutionCompleted,
  ToolExecutionStarted,
  ToolInputEnd,
  ToolInputStart,
  ToolResult,
  ToolResultMessage,
  UserMessage,
  UserMessageEvent,
  zeroAgentUsage,
  type AgentEvent,
  type AgentMessage
} from '@yolk-sdk/agent/protocol'
import { reduceAgentEvents } from '../../src/client'
import {
  applyAgentEventToChatProjection,
  initialAgentChatState,
  makeAgentChatEventProjectionState,
  reduceAgentChatState
} from '../../src/react/chat-core.ts'
import { AgentChatAction } from '../../src/react/chat-actions.ts'
import type { AgentChatMessage } from '../../src/react/chat-messages.ts'

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

/** Per assistant chat message: its text, and its tool calls as `id:state`. */
const shown = (messages: ReadonlyArray<AgentChatMessage>) =>
  messages.flatMap(chatMessage =>
    chatMessage.role !== 'assistant'
      ? []
      : [
          chatMessage.parts
            .flatMap(part => {
              if (Predicate.isTagged(part, 'Text')) return [part.content]

              if (Predicate.isTagged(part, 'ToolCall'))
                return [`${part.call.id}:${part.state._tag}`]

              return []
            })
            .join(' | ')
        ]
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
