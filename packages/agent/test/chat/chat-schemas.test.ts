import { describe, expect, expectTypeOf, it } from '@effect/vitest'
import { Effect, Equal, Option, type HashSet } from 'effect'
import * as Schema from 'effect/Schema'
import {
  AgentAwaitingInput,
  AssistantAgentMessage,
  AssistantMessageEvent,
  AssistantTextPart,
  HostToolCallPart,
  LLMStreamStart,
  LLMTextDelta,
  TextPart,
  ToolApprovalRequest,
  ToolApprovalRequested,
  ToolCall,
  ToolExecutionCompleted,
  ToolExecutionStarted,
  ToolInputEnd,
  ToolResult,
  ToolResultMessage,
  UserMessage,
  zeroAgentUsage,
  type AgentEvent,
  type AgentMessage
} from '@yolk-sdk/agent/protocol'
import {
  AgentChatEventProjectionStateSchema,
  AgentChatExecutionOutput,
  AgentChatExecutionOutputSchema,
  AgentChatExecutionsSchema,
  AgentChatMessageSchema,
  AgentChatPart,
  AgentChatStateSchema,
  ChatToolState,
  buildAgentChatMessages,
  initialAgentChatState,
  makeAgentChatEventProjectionState,
  markChatRunStart,
  reduceAgentChatState,
  stepAgentChatProjectionAll,
  type AgentChatEventProjectionState,
  type AgentChatMessage,
  type AgentChatState,
  type AgentExecutions
} from '@yolk-sdk/agent/chat'
import type { AgentExecutionsSchema } from '@yolk-sdk/agent/chat'
import { AgentChatAction } from '../../src/chat/chat-actions.ts'

/** Encodes to JSON text and decodes it back, as a host keeping the state would. */
const roundTrip = <S extends Schema.Codec<unknown, unknown>>(schema: S, value: S['Type']) =>
  Effect.gen(function* () {
    const codec = Schema.toCodecJson(schema)
    const text = JSON.stringify(yield* Schema.encodeEffect(codec)(value))
    const json: unknown = JSON.parse(text)

    return { json, decoded: yield* Schema.decodeUnknownEffect(codec)(json) }
  })

/** The state with `seenEventIds` as sorted ids, so `toEqual` compares the set's members. */
const comparable = <State extends { readonly seenEventIds: HashSet.HashSet<string> }>(
  state: State
) => ({ ...state, seenEventIds: [...state.seenEventIds].sort() })

const history: ReadonlyArray<AgentMessage> = [
  UserMessage.make({ content: 'Find the forecast', createdAtMs: 1, author: { displayName: 'A' } }),
  AssistantAgentMessage.make({
    parts: [
      AssistantTextPart.make({ content: 'Looking' }),
      HostToolCallPart.make({ call: ToolCall.make({ id: 'old', name: 'search', params: {} }) })
    ],
    annotations: { source: 'snapshot' }
  }),
  ToolResultMessage.make({ toolCallId: 'old', content: 'sunny', structuredContent: { sky: 1 } })
]

/** The JSON form of `seenEventIds`: an array of ids. */
const SeenEventIdsJson = Schema.Struct({ seenEventIds: Schema.Array(Schema.String) })

const tagged = (executionId: string, index: number) => ({
  eventId: `run:${executionId}:${index}`,
  streamId: 'run',
  executionId,
  executionTurn: 1
})

const host = (index: number) => ({ eventId: `run:host:${index}`, streamId: 'run' })

const call = ToolCall.make({ id: 'weather', name: 'weather', params: { city: 'Bergen' } })

const answer = AssistantAgentMessage.make({
  parts: [AssistantTextPart.make({ content: 'Checking' }), HostToolCallPart.make({ call })]
})

/** One execution of turn 1: its start, a delta, the call and its answer. */
const execution = (executionId: string): ReadonlyArray<AgentEvent> => [
  LLMStreamStart.make({ ...tagged(executionId, 0), turn: 1 }),
  LLMTextDelta.make({ ...tagged(executionId, 1), text: 'Checking' }),
  ToolInputEnd.make({ ...tagged(executionId, 2), call }),
  AssistantMessageEvent.make({ ...tagged(executionId, 3), message: answer })
]

const approval = ToolApprovalRequest.make({
  requestId: 'approval:weather',
  toolCallId: call.id,
  call
})

const pause = AgentAwaitingInput.make({
  ...host(1),
  requests: [approval],
  messages: [answer],
  turns: 1,
  usage: zeroAgentUsage
})

const snapshot = () =>
  markChatRunStart(
    makeAgentChatEventProjectionState(
      buildAgentChatMessages({
        messages: history,
        userDraft: '',
        assistantDraft: '',
        reasoningDraft: '',
        toolRuns: [],
        error: null
      })
    )
  )

/** Mid-run: turn 1 ran twice (the first execution superseded, the second live). */
const midRun = (): AgentChatEventProjectionState =>
  stepAgentChatProjectionAll(snapshot(), [...execution('step:1:a'), ...execution('step:1:b')])
    .projection

const rest: ReadonlyArray<AgentEvent> = [
  ToolApprovalRequested.make({ ...host(0), call, request: approval }),
  pause,
  ToolExecutionStarted.make({ ...host(2), call }),
  ToolExecutionCompleted.make({
    ...host(3),
    call,
    result: ToolResult.make({ toolCallId: call.id, content: 'rain' })
  })
]

describe('chat projection Schemas', () => {
  it.effect('round-trips a live projection through JSON, and the fold continues the same', () =>
    Effect.gen(function* () {
      const state = midRun()

      expect(state.executions?.flatMap(run => run.executions.map(e => e.status))).toEqual([
        'Superseded',
        'Live'
      ])

      const { json, decoded } = yield* roundTrip(AgentChatEventProjectionStateSchema, state)

      expect(comparable(decoded)).toEqual(comparable(state))
      expect(Equal.equals(decoded.seenEventIds, state.seenEventIds)).toBe(true)

      // The JSON form of `seenEventIds` is the array of ids.
      const { seenEventIds } = yield* Schema.decodeUnknownEffect(SeenEventIdsJson)(json)

      expect([...seenEventIds].sort()).toEqual([...state.seenEventIds].sort())

      const continued = stepAgentChatProjectionAll(state, rest, { nowMs: 5 })
      const fromDecoded = stepAgentChatProjectionAll(decoded, rest, { nowMs: 5 })

      expect(comparable(fromDecoded.projection)).toEqual(comparable(continued.projection))
      expect(fromDecoded.statusEvents).toEqual(continued.statusEvents)

      // Replays stay deduped after the round trip.
      const replayed = stepAgentChatProjectionAll(fromDecoded.projection, [
        ...execution('step:1:b')
      ])

      expect(replayed.projection).toBe(fromDecoded.projection)
      expect(replayed.statusEvents).toEqual([])
    })
  )

  it.effect('round-trips every chat part, tool state and execution output', () =>
    Effect.gen(function* () {
      const toolPart = (id: string, state: ChatToolState) =>
        AgentChatPart.ToolCall({ id, call, state })

      const message: AgentChatMessage = {
        id: 'message-1-assistant',
        turnId: 'turn-1',
        sequence: 1,
        role: 'assistant',
        createdAtMs: 3,
        author: { displayName: 'Agent' },
        annotations: { pinned: true, tags: ['a'] },
        instructionsAfter: [UserMessage.make({ content: 'be brief', instruction: { key: 'k' } })],
        parts: [
          AgentChatPart.Text({ id: 'text', content: 'hello', state: 'streaming' }),
          AgentChatPart.Reasoning({ id: 'reasoning', text: 'hmm', state: 'done' }),
          toolPart('called', ChatToolState.Called()),
          toolPart('input', ChatToolState.InputStreaming({ input: '{"ci' })),
          toolPart('approval', ChatToolState.ApprovalRequested({ request: approval })),
          toolPart('denied', ChatToolState.Denied({ reason: 'no', request: approval })),
          toolPart('running', ChatToolState.Running({ startedAtMs: 4 })),
          toolPart(
            'completed',
            ChatToolState.Completed({
              result: ToolResult.make({
                toolCallId: call.id,
                content: 'ok',
                structuredContent: [1]
              }),
              startedAtMs: 4,
              endedAtMs: 5
            })
          ),
          toolPart(
            'accepted',
            ChatToolState.Accepted({
              result: ToolResult.make({ toolCallId: call.id, content: 'queued' }),
              resultEnvelope: { createdAtMs: 6, annotations: { job: 'j' } }
            })
          ),
          toolPart('errored', ChatToolState.Errored({ message: 'boom', endedAtMs: 7 })),
          toolPart(
            'provider',
            ChatToolState.ProviderCompleted({
              result: ToolResult.make({ toolCallId: call.id, content: 'web' })
            })
          ),
          AgentChatPart.ToolResult({
            id: 'result',
            toolCallId: call.id,
            name: call.name,
            content: [TextPart.make({ text: 'rain' })],
            isError: false,
            structuredContent: { mm: 3 }
          }),
          AgentChatPart.Error({ id: 'error', message: 'failed' })
        ]
      }

      expect((yield* roundTrip(AgentChatMessageSchema, message)).decoded).toEqual(message)

      const outputs: ReadonlyArray<AgentChatExecutionOutput> = [
        AgentChatExecutionOutput.After({ messageId: Option.none() }),
        AgentChatExecutionOutput.After({ messageId: Option.some('message-0-user') }),
        AgentChatExecutionOutput.Message({ messageId: message.id }),
        AgentChatExecutionOutput.ToolPart({
          callId: call.id,
          messageId: message.id,
          prior: Option.some(toolPart('prior', ChatToolState.Called()))
        }),
        AgentChatExecutionOutput.ToolPart({
          callId: call.id,
          messageId: message.id,
          prior: Option.none()
        }),
        AgentChatExecutionOutput.ReplacedMessage({ prior: message }),
        AgentChatExecutionOutput.Until({ messageId: Option.some(message.id) })
      ]

      const executions: AgentExecutions<AgentChatExecutionOutput> = [
        {
          streamId: 'run',
          ended: false,
          closedThroughTurn: 0,
          retired: false,
          executions: [
            {
              executionId: 'a',
              turn: 1,
              status: 'Superseded',
              calls: [],
              output: [],
              answer
            },
            { executionId: 'b', turn: 1, status: 'Live', calls: [call.id], output: outputs }
          ]
        }
      ]

      expect((yield* roundTrip(AgentChatExecutionsSchema, executions)).decoded).toEqual(executions)

      for (const output of outputs) {
        expect((yield* roundTrip(AgentChatExecutionOutputSchema, output)).decoded).toEqual(output)
      }
    })
  )

  it.effect('round-trips the reducer state, with status, session events and pauses', () =>
    Effect.gen(function* () {
      const state = [
        AgentChatAction.Submit({ message: UserMessage.make({ content: 'Bergen?' }) }),
        ...[...execution('step:1:a'), ToolApprovalRequested.make({ ...host(0), call }), pause].map(
          event => AgentChatAction.Event({ event, nowMs: 1 })
        )
      ].reduce(reduceAgentChatState, initialAgentChatState)

      expect(state.status._tag).toBe('Blocked')
      expect(state.hitlPauses?.get(approval.requestId)).toBe(pause.eventId)

      const { decoded } = yield* roundTrip(AgentChatStateSchema, state)

      expect(comparable(decoded)).toEqual(comparable(state))

      const answered = AgentChatAction.Event({
        event: ToolExecutionStarted.make({ ...host(2), call }),
        nowMs: 2
      })

      expect(comparable(reduceAgentChatState(decoded, answered))).toEqual(
        comparable(reduceAgentChatState(state, answered))
      )
    })
  )

  it('derives the chat types from the Schemas', () => {
    expectTypeOf<
      typeof AgentChatEventProjectionStateSchema.Type
    >().toEqualTypeOf<AgentChatEventProjectionState>()

    expectTypeOf<typeof AgentChatStateSchema.Type>().toEqualTypeOf<AgentChatState>()

    expectTypeOf<typeof AgentChatExecutionsSchema.Type>().toEqualTypeOf<
      AgentExecutions<AgentChatExecutionOutput>
    >()

    // The generic Schema types any reducer's output.
    const Output = Schema.Struct({ id: Schema.String })

    expectTypeOf<ReturnType<typeof AgentExecutionsSchema<typeof Output>>['Type']>().toEqualTypeOf<
      AgentExecutions<typeof Output.Type>
    >()
  })
})
