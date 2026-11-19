import { describe, expect, it } from '@effect/vitest'
import { Predicate } from 'effect'
import {
  AgentEnd,
  AssistantAgentMessage,
  AssistantMessageEvent,
  AssistantTextPart,
  HostToolCallPart,
  LLMStreamStart,
  LLMTextDelta,
  ToolCall,
  ToolExecutionCompleted,
  ToolExecutionStarted,
  ToolInputEnd,
  ToolInputStart,
  ToolResult,
  ToolResultMessage,
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
const live = <Event extends AgentEvent>(make: (identity: Identity) => Event, executionId: string) =>
  make({ eventId: `run:${(sequence += 1)}:${executionId}`, executionId })

/** A host event every execution writes identically (plain id, no execution). */
const plain = <Event extends AgentEvent>(make: (identity: PlainIdentity) => Event, id: string) =>
  make({ eventId: `run:${id}` })

type Identity = { readonly eventId: string; readonly executionId: string }

type PlainIdentity = { readonly eventId: string }

const answer = (content: string, calls: ReadonlyArray<ToolCall> = []) =>
  AssistantAgentMessage.make({
    parts: [
      AssistantTextPart.make({ content }),
      ...calls.map(call => HostToolCallPart.make({ call }))
    ]
  })

const start = (executionId: string, turn: number) =>
  live(identity => LLMStreamStart.make({ ...identity, turn }), executionId)

const delta = (executionId: string, text: string) =>
  live(identity => LLMTextDelta.make({ ...identity, text }), executionId)

const message = (executionId: string, value: AssistantAgentMessage) =>
  live(identity => AssistantMessageEvent.make({ ...identity, message: value }), executionId)

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
