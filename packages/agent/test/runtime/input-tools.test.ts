import { Effect, Layer, Option, Predicate, Result, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  InputResponse,
  ToolCall,
  UserMessage,
  type AgentEvent,
  type InputToolHandler
} from '@yolk-sdk/agent/protocol'
import { ContextTransformer, LoopConfig, type LLMRequest } from '@yolk-sdk/agent/loop'
import { FauxProvider, Reply, TestToolExecutor } from '@yolk-sdk/agent/loop/testing'
import {
  makeInMemorySessionEventStoreLayer,
  replayRuntimeHitlResponses,
  runRuntime,
  SessionEventStore,
  type RuntimeConfig
} from '../../src/runtime/index.ts'
import { RuntimeRequest } from '../../src/runtime/run-runtime.ts'
import { makeInputToolDef } from '../../src/tools/index.ts'

const NotEvil = Schema.String.pipe(
  Schema.refine((value): value is string => value !== 'evil', { identifier: 'NotEvil' })
)

const wordDef = makeInputToolDef({
  name: 'word',
  description: 'Collect a word.',
  renderer: 'text-field'
})

const wordHandler: InputToolHandler = {
  validateCall: params =>
    Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Never))(params),
  validateResponse: data => Schema.decodeUnknownEffect(NotEvil)(data).pipe(Effect.asVoid),
  formatContent: ({ name, data }) => `Word ${name}: ${JSON.stringify(data)}`
}

const runtimeConfig: RuntimeConfig = {
  systemPrompt: 'Collect a word.',
  tools: [wordDef],
  inputs: { word: wordHandler },
  model: 'faux'
}

const wordCall = ToolCall.make({ id: 'call_word', name: 'word', params: {} })

const submitted = (data: Schema.Json) =>
  InputResponse.make({
    requestId: 'input:word:call_word',
    toolCallId: wordCall.id,
    outcome: 'submitted',
    source: 'user',
    data
  })

const makeLayer = (
  requests: Array<LLMRequest>,
  responses: Parameters<typeof FauxProvider.layerWithRequests>[0]['responses']
) =>
  Layer.mergeAll(
    ContextTransformer.identity,
    LoopConfig.defaultLayer,
    FauxProvider.layerWithRequests({ responses, requests }),
    TestToolExecutor.layer({}),
    makeInMemorySessionEventStoreLayer()
  )

const awaitingInput = (events: ReadonlyArray<AgentEvent>) =>
  events.find(event => Predicate.isTagged(event, 'AgentAwaitingInput'))

describe('input runtime persistence', () => {
  it.effect('persists pending input and resumes through reconnect', () => {
    const firstRequests: Array<LLMRequest> = []

    const layer = makeLayer(firstRequests, [Reply.toolCall(wordCall), Reply.text('thanks')])

    return Effect.gen(function* () {
      const pausedChunk = yield* runRuntime(
        RuntimeRequest.AppendInput({
          sessionId: 'session_1',
          input: UserMessage.make({ content: 'give me a word' }),
          runId: 'run_1'
        }),
        runtimeConfig
      ).pipe(Stream.runCollect)

      const paused = Array.from(pausedChunk)
      expect(paused.map(event => event._tag)).toContain('InputRequested')
      expect(awaitingInput(paused)).not.toBeUndefined()

      const store = yield* SessionEventStore
      const pausedLog = yield* store.load('session_1')
      expect(pausedLog.events.map(stored => stored.event._tag)).toEqual([
        'InputAppended',
        'RunStarted',
        'RunAwaitingInput'
      ])
      expect(firstRequests).toHaveLength(1)

      const resumedChunk = yield* runRuntime(
        RuntimeRequest.AppendHitlResponse({
          sessionId: 'session_1',
          response: submitted('kind'),
          runId: 'run_2',
          expectedRevision: pausedLog.revision
        }),
        runtimeConfig
      ).pipe(Stream.runCollect)

      const resumed = Array.from(resumedChunk)
      expect(resumed.map(event => event._tag)).toContain('InputSubmitted')
      expect(resumed.map(event => event._tag)).toContain('AgentEnd')

      const resumedLog = yield* store.load('session_1')
      expect(resumedLog.events.map(stored => stored.event._tag)).toEqual([
        'InputAppended',
        'RunStarted',
        'RunAwaitingInput',
        'HitlResponseAppended',
        'RunStarted',
        'RunCompleted'
      ])
      expect(replayRuntimeHitlResponses(resumedLog.events)).toEqual([submitted('kind')])
      expect(firstRequests).toHaveLength(2)

      const resultMessage = firstRequests[1]?.messages.at(-1)

      if (!Predicate.isTagged(resultMessage, 'ToolResult')) {
        throw new Error('Expected tool result message')
      }

      expect(resultMessage.structuredContent).toEqual({
        type: 'input_response',
        name: 'word',
        outcome: 'submitted',
        data: 'kind',
        source: 'user'
      })
    }).pipe(Effect.provide(layer))
  })

  it.effect('re-awaits invalid payloads and completes corrected resubmission', () => {
    const requests: Array<LLMRequest> = []

    const layer = makeLayer(requests, [Reply.toolCall(wordCall), Reply.text('thanks')])

    return Effect.gen(function* () {
      const pausedChunk = yield* runRuntime(
        RuntimeRequest.AppendInput({
          sessionId: 'session_2',
          input: UserMessage.make({ content: 'give me a word' }),
          runId: 'run_1'
        }),
        runtimeConfig
      ).pipe(Stream.runCollect)

      expect(awaitingInput(Array.from(pausedChunk))).not.toBeUndefined()

      const invalidChunk = yield* runRuntime(
        RuntimeRequest.AppendHitlResponse({
          sessionId: 'session_2',
          response: submitted('evil'),
          runId: 'run_2'
        }),
        runtimeConfig
      ).pipe(Stream.runCollect)

      const invalidEvents = Array.from(invalidChunk)
      expect(awaitingInput(invalidEvents)).not.toBeUndefined()
      expect(invalidEvents.map(event => event._tag)).not.toContain('AgentEnd')

      const correctedChunk = yield* runRuntime(
        RuntimeRequest.AppendHitlResponse({
          sessionId: 'session_2',
          response: submitted('kind'),
          runId: 'run_3'
        }),
        runtimeConfig
      ).pipe(Stream.runCollect)

      const corrected = Array.from(correctedChunk)
      expect(corrected.map(event => event._tag)).toContain('AgentEnd')

      const store = yield* SessionEventStore
      const log = yield* store.load('session_2')
      expect(replayRuntimeHitlResponses(log.events)).toEqual([submitted('evil'), submitted('kind')])

      expect(requests).toHaveLength(2)

      const resultMessage = requests[1]?.messages.at(-1)

      if (!Predicate.isTagged(resultMessage, 'ToolResult')) {
        throw new Error('Expected tool result message')
      }

      expect(resultMessage.structuredContent).toEqual({
        type: 'input_response',
        name: 'word',
        outcome: 'submitted',
        data: 'kind',
        source: 'user'
      })
    }).pipe(Effect.provide(layer))
  })

  it.effect('rejects mismatched input responses without running', () => {
    const requests: Array<LLMRequest> = []
    const layer = makeLayer(requests, [Reply.toolCall(wordCall)])

    return Effect.gen(function* () {
      const pausedChunk = yield* runRuntime(
        RuntimeRequest.AppendInput({
          sessionId: 'session_3',
          input: UserMessage.make({ content: 'give me a word' }),
          runId: 'run_1'
        }),
        runtimeConfig
      ).pipe(Stream.runCollect)

      expect(awaitingInput(Array.from(pausedChunk))).not.toBeUndefined()

      const stale = InputResponse.make({
        requestId: 'input:word:other_call',
        toolCallId: 'other_call',
        outcome: 'submitted',
        source: 'user',
        data: 'kind'
      })

      const result = yield* runRuntime(
        RuntimeRequest.AppendHitlResponse({
          sessionId: 'session_3',
          response: stale,
          runId: 'run_2'
        }),
        runtimeConfig
      ).pipe(Stream.runCollect, Effect.result)

      expect(Result.isFailure(result)).toBe(true)

      const failure = Option.getOrThrow(Result.getFailure(result))

      if (!Predicate.isTagged(failure, 'SessionConflictError')) {
        throw new Error('Expected SessionConflictError')
      }

      expect(requests).toHaveLength(1)
    }).pipe(Effect.provide(layer))
  })
})
