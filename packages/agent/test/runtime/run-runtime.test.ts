import { Data, Effect, Exit, Layer, Option, Predicate, Result, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AssistantAgentMessage,
  HostToolCallPart,
  AssistantTextPart,
  ToolCall,
  ToolApprovalPolicy,
  ToolApprovalResponse,
  ToolDef,
  UserMessage,
  textOnlyModelCapabilities,
  type AgentMessage,
  type HitlResponse
} from '@yolk-sdk/agent/protocol'
import {
  agentLoopErrorToAgentError,
  ContextTransformer,
  LoopConfig,
  type LLMRequest
} from '@yolk-sdk/agent/loop'
import { FauxProvider, Reply, TestToolExecutor } from '@yolk-sdk/agent/loop/testing'
import {
  appendRuntimeSessionEventsToLog,
  InputAppended,
  makeInMemorySessionEventStoreLayer,
  replayRuntimeSessionEvents,
  runRuntime,
  SessionEventStore,
  type RuntimeConfig,
  type RuntimeSessionEventLog,
  type RuntimeTranscript,
  type SessionRevision
} from '../../src/runtime'

const runtimeConfig: RuntimeConfig = {
  systemPrompt: 'Be brief.',
  tools: [],
  model: 'faux'
}

class TranscriptRuntimeRequest extends Data.TaggedClass('Transcript')<{
  readonly sessionId: string
  readonly messages: RuntimeTranscript
}> {}

class AppendInputRuntimeRequest extends Data.TaggedClass('AppendInput')<{
  readonly sessionId: string
  readonly input: AgentMessage
  readonly runId: string
  readonly expectedRevision?: SessionRevision
}> {}

class AppendHitlResponseRuntimeRequest extends Data.TaggedClass('AppendHitlResponse')<{
  readonly sessionId: string
  readonly response: HitlResponse
  readonly runId: string
  readonly expectedRevision?: SessionRevision
}> {}

const makeAgentLoopLayer = (
  requests: Array<LLMRequest> = [],
  responses: Parameters<typeof FauxProvider.layerWithRequests>[0]['responses'] = [Reply.text('ok')],
  toolResults: Parameters<typeof TestToolExecutor.layer>[0] = {}
) =>
  Layer.mergeAll(
    ContextTransformer.identity,
    LoopConfig.defaultLayer,
    FauxProvider.layerWithRequests({ responses, requests }),
    TestToolExecutor.layer(toolResults)
  )

const getFirstRequest = (requests: ReadonlyArray<LLMRequest>) => {
  const request = requests[0]

  if (request === undefined) {
    throw new Error('Expected provider request')
  }

  return request
}

describe('runRuntime', () => {
  it.effect('runs transcript mode without loading or saving session state by default', () =>
    Effect.gen(function* () {
      const requests: Array<LLMRequest> = []
      const messages: RuntimeTranscript = [UserMessage.make({ content: 'client owned transcript' })]

      const eventsChunk = yield* runRuntime(
        new TranscriptRuntimeRequest({
          sessionId: 'session_1',
          messages
        }),
        runtimeConfig
      ).pipe(Stream.runCollect, Effect.provide(makeAgentLoopLayer(requests)))

      expect(Array.from(eventsChunk).map(event => event._tag)).toContain('AgentEnd')
      expect(getFirstRequest(requests).messages).toEqual(messages)
    })
  )

  it.effect('passes reasoning effort and capabilities to the agent loop', () =>
    Effect.gen(function* () {
      const requests: Array<LLMRequest> = []

      yield* runRuntime(
        new TranscriptRuntimeRequest({
          sessionId: 'session_1',
          messages: [UserMessage.make({ content: 'reason about this' })]
        }),
        {
          ...runtimeConfig,
          reasoningEffort: 'medium',
          capabilities: textOnlyModelCapabilities
        }
      ).pipe(Stream.runCollect, Effect.provide(makeAgentLoopLayer(requests)))

      expect(getFirstRequest(requests).reasoningEffort).toBe('medium')
    })
  )

  it.effect('runs append input mode from replayed session events', () => {
    const requests: Array<LLMRequest> = []
    const old = UserMessage.make({ content: 'old' })
    const input = UserMessage.make({ content: 'new' })

    const initialLog: RuntimeSessionEventLog = {
      sessionId: 'session_1',
      revision: 1,
      events: [
        {
          id: 'session_1:1',
          sessionId: 'session_1',
          revision: 1,
          event: InputAppended.make({ message: old })
        }
      ]
    }

    const layer = Layer.mergeAll(
      makeAgentLoopLayer(requests),
      makeInMemorySessionEventStoreLayer([initialLog])
    )

    return Effect.gen(function* () {
      const eventsChunk = yield* runRuntime(
        new AppendInputRuntimeRequest({
          sessionId: 'session_1',
          input,
          runId: 'run_1',
          expectedRevision: 1
        }),
        runtimeConfig
      ).pipe(Stream.runCollect)

      const store = yield* SessionEventStore
      const log = yield* store.load('session_1')

      const assistant = AssistantAgentMessage.make({
        parts: [AssistantTextPart.make({ content: 'ok' })]
      })

      expect(Array.from(eventsChunk).map(event => event._tag)).toContain('AgentEnd')
      expect(getFirstRequest(requests).messages).toEqual([old, input])
      expect(log.events.map(event => event.event._tag)).toEqual([
        'InputAppended',
        'InputAppended',
        'RunStarted',
        'RunCompleted'
      ])
      expect(log.revision).toBe(4)
      expect(log.events.map(event => event.revision)).toEqual([1, 2, 3, 4])
      expect(replayRuntimeSessionEvents(log.events)).toEqual([old, input, assistant])
    }).pipe(Effect.provide(layer))
  })

  it.effect('persists pending HITL state and resumes from a response', () => {
    const requests: Array<LLMRequest> = []
    const input = UserMessage.make({ content: 'weather?' })

    const tool = ToolDef.make({
      name: 'weather',
      description: 'Get weather.',
      parameters: {},
      approval: ToolApprovalPolicy.make({ mode: 'manual', reason: 'external lookup' })
    })

    const config = { ...runtimeConfig, tools: [tool] }

    const layer = Layer.mergeAll(
      makeAgentLoopLayer(
        requests,
        [
          Reply.toolCall({ id: 'call_1', name: 'weather', params: { city: 'Paris' } }),
          Reply.text('sunny')
        ],
        { weather: '72F' }
      ),
      makeInMemorySessionEventStoreLayer()
    )

    return Effect.gen(function* () {
      const pausedChunk = yield* runRuntime(
        new AppendInputRuntimeRequest({
          sessionId: 'session_1',
          input,
          runId: 'run_1'
        }),
        config
      ).pipe(Stream.runCollect)

      const pausedEvents = Array.from(pausedChunk)
      const store = yield* SessionEventStore
      const pausedLog = yield* store.load('session_1')

      expect(pausedEvents.map(event => event._tag)).toContain('AgentAwaitingInput')
      expect(pausedLog.events.map(event => event.event._tag)).toEqual([
        'InputAppended',
        'RunStarted',
        'RunAwaitingInput'
      ])

      const response = ToolApprovalResponse.make({
        requestId: 'approval:call_1',
        toolCallId: 'call_1',
        decision: 'approved',
        source: 'user'
      })

      const resumedChunk = yield* runRuntime(
        new AppendHitlResponseRuntimeRequest({
          sessionId: 'session_1',
          response,
          runId: 'run_2',
          expectedRevision: pausedLog.revision
        }),
        config
      ).pipe(Stream.runCollect)

      const resumedEvents = Array.from(resumedChunk)
      const resumedLog = yield* store.load('session_1')

      const firstAssistant = AssistantAgentMessage.make({
        parts: [
          HostToolCallPart.make({
            call: ToolCall.make({ id: 'call_1', name: 'weather', params: { city: 'Paris' } })
          })
        ]
      })

      const toolResult = resumedLog.events.flatMap(event =>
        Predicate.isTagged(event.event, 'RunCompleted')
          ? event.event.messages.filter(message => Predicate.isTagged(message, 'ToolResult'))
          : []
      )[0]

      expect(resumedEvents.map(event => event._tag)).toContain('ToolApprovalGranted')
      expect(resumedEvents.map(event => event._tag)).toContain('ToolExecutionCompleted')
      expect(resumedEvents.map(event => event._tag)).toContain('AgentEnd')
      expect(resumedLog.events.map(event => event.event._tag)).toEqual([
        'InputAppended',
        'RunStarted',
        'RunAwaitingInput',
        'HitlResponseAppended',
        'RunStarted',
        'RunCompleted'
      ])
      expect(replayRuntimeSessionEvents(resumedLog.events)).toEqual([
        input,
        firstAssistant,
        toolResult,
        AssistantAgentMessage.make({ parts: [AssistantTextPart.make({ content: 'sunny' })] })
      ])
      expect(requests[1]?.messages.map(message => message._tag)).toEqual([
        'User',
        'Assistant',
        'ToolResult'
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect('persists awaiting input again when an HITL resume pauses for another approval', () => {
    const requests: Array<LLMRequest> = []
    const input = UserMessage.make({ content: 'two approvals' })

    const tool = ToolDef.make({
      name: 'weather',
      description: 'Get weather.',
      parameters: {},
      approval: ToolApprovalPolicy.make({ mode: 'manual', reason: 'external lookup' })
    })

    const config = { ...runtimeConfig, tools: [tool] }

    const layer = Layer.mergeAll(
      makeAgentLoopLayer(
        requests,
        [
          Reply.toolCall({ id: 'call_1', name: 'weather', params: {} }),
          Reply.toolCall({ id: 'call_2', name: 'weather', params: {} }),
          Reply.text('done')
        ],
        { weather: '72F' }
      ),
      makeInMemorySessionEventStoreLayer()
    )

    return Effect.gen(function* () {
      const firstChunk = yield* runRuntime(
        new AppendInputRuntimeRequest({
          sessionId: 'session_1',
          input,
          runId: 'run_1'
        }),
        config
      ).pipe(Stream.runCollect)

      expect(Array.from(firstChunk).map(event => event._tag)).toContain('AgentAwaitingInput')

      const store = yield* SessionEventStore
      const pausedLog = yield* store.load('session_1')

      expect(pausedLog.events.map(event => event.event._tag)).toEqual([
        'InputAppended',
        'RunStarted',
        'RunAwaitingInput'
      ])
      expect(pausedLog.revision).toBe(3)

      const firstResponse = ToolApprovalResponse.make({
        requestId: 'approval:call_1',
        toolCallId: 'call_1',
        decision: 'approved',
        source: 'user'
      })

      const secondChunk = yield* runRuntime(
        new AppendHitlResponseRuntimeRequest({
          sessionId: 'session_1',
          response: firstResponse,
          runId: 'run_2',
          expectedRevision: pausedLog.revision
        }),
        config
      ).pipe(Stream.runCollect)

      expect(Array.from(secondChunk).map(event => event._tag)).toContain('AgentAwaitingInput')

      const repausedLog = yield* store.load('session_1')

      expect(repausedLog.events.map(event => event.event._tag)).toEqual([
        'InputAppended',
        'RunStarted',
        'RunAwaitingInput',
        'HitlResponseAppended',
        'RunStarted',
        'RunAwaitingInput'
      ])
      expect(repausedLog.revision).toBe(6)

      const secondResponse = ToolApprovalResponse.make({
        requestId: 'approval:call_2',
        toolCallId: 'call_2',
        decision: 'approved',
        source: 'user'
      })

      const finalChunk = yield* runRuntime(
        new AppendHitlResponseRuntimeRequest({
          sessionId: 'session_1',
          response: secondResponse,
          runId: 'run_3',
          expectedRevision: repausedLog.revision
        }),
        config
      ).pipe(Stream.runCollect)

      expect(Array.from(finalChunk).map(event => event._tag)).toContain('AgentEnd')

      const finalLog = yield* store.load('session_1')

      expect(finalLog.events.map(event => event.event._tag)).toEqual([
        'InputAppended',
        'RunStarted',
        'RunAwaitingInput',
        'HitlResponseAppended',
        'RunStarted',
        'RunAwaitingInput',
        'HitlResponseAppended',
        'RunStarted',
        'RunCompleted'
      ])
      expect(finalLog.revision).toBe(9)
    }).pipe(Effect.provide(layer))
  })

  it.effect('records run failure in append input mode without completed messages', () => {
    const input = UserMessage.make({ content: 'new' })
    const layer = Layer.mergeAll(makeAgentLoopLayer([], []), makeInMemorySessionEventStoreLayer())

    return Effect.gen(function* () {
      const exit = yield* runRuntime(
        new AppendInputRuntimeRequest({
          sessionId: 'session_1',
          input,
          runId: 'run_1'
        }),
        runtimeConfig
      ).pipe(Stream.runCollect, Effect.exit)

      const store = yield* SessionEventStore
      const log = yield* store.load('session_1')

      expect(exit._tag).toBe('Failure')

      if (!Exit.isFailure(exit)) {
        throw new Error('Expected the append run to fail')
      }

      const original = Option.getOrThrow(Exit.findErrorOption(exit))

      if (!Predicate.isTagged(original, 'FauxExhaustedError')) {
        throw new Error('Expected the original faux-exhausted failure')
      }

      const storedErrors = log.events.flatMap(stored =>
        Predicate.isTagged(stored.event, 'RunFailed') ? [stored.event.error] : []
      )

      expect(log.events.map(event => event.event._tag)).toEqual([
        'InputAppended',
        'RunStarted',
        'RunFailed'
      ])
      expect(storedErrors).toEqual([agentLoopErrorToAgentError(original)])
      expect(replayRuntimeSessionEvents(log.events)).toEqual([input])
    }).pipe(Effect.provide(layer))
  })

  it.effect('rejects append input mode with stale expected revision', () =>
    Effect.gen(function* () {
      const old = UserMessage.make({ content: 'old' })

      const initialLog: RuntimeSessionEventLog = {
        sessionId: 'session_1',
        revision: 1,
        events: [
          {
            id: 'session_1:1',
            sessionId: 'session_1',
            revision: 1,
            event: InputAppended.make({ message: old })
          }
        ]
      }

      const result = yield* runRuntime(
        new AppendInputRuntimeRequest({
          sessionId: 'session_1',
          input: UserMessage.make({ content: 'new' }),
          runId: 'run_1',
          expectedRevision: 0
        }),
        runtimeConfig
      ).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(makeAgentLoopLayer(), makeInMemorySessionEventStoreLayer([initialLog]))
        ),
        Effect.result
      )

      expect(Result.isFailure(result)).toBe(true)

      const failure = Option.getOrThrow(Result.getFailure(result))

      if (!Predicate.isTagged(failure, 'SessionConflictError')) {
        throw new Error('Expected SessionConflictError')
      }

      expect(failure.sessionId).toBe('session_1')
    })
  )

  it('appends runtime session events with deterministic revisions', () => {
    const first = UserMessage.make({ content: 'first' })
    const second = UserMessage.make({ content: 'second' })

    const initialLog: RuntimeSessionEventLog = {
      sessionId: 'session_1',
      revision: 1,
      events: [
        {
          id: 'session_1:1',
          sessionId: 'session_1',
          revision: 1,
          event: InputAppended.make({ message: first })
        }
      ]
    }

    const nextLog = appendRuntimeSessionEventsToLog(initialLog, {
      sessionId: 'session_1',
      expectedRevision: 1,
      events: [InputAppended.make({ message: second })]
    })

    expect(nextLog.revision).toBe(2)
    expect(nextLog.events.map(event => event.id)).toEqual(['session_1:1', 'session_1:2'])
    expect(replayRuntimeSessionEvents(nextLog.events)).toEqual([first, second])
  })
})
