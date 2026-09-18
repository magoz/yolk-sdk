import { Effect, Layer, Predicate, Stream } from 'effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from '@effect/vitest'
import {
  InputResponse,
  QuestionAnswer,
  QuestionResponse,
  ToolApprovalPolicy,
  ToolCall,
  ToolDef,
  UserMessage,
  type AgentEvent,
  type InputToolHandler
} from '@yolk-sdk/agent/protocol'
import {
  ContextTransformer,
  LoopConfig,
  ToolError,
  ToolExecutor,
  prepareToolBatch,
  run,
  runToolBatch,
  type LLMRequest
} from '../../src/loop/index.ts'
import { FauxProvider, Reply, TestToolExecutor } from '../../src/loop/testing/index.ts'
import { makeInputTool, makeInputToolDef, resolveTools } from '../../src/tools/index.ts'

const BaseLayer = Layer.mergeAll(ContextTransformer.identity, LoopConfig.defaultLayer)

const NotEvil = Schema.String.pipe(
  Schema.refine((value): value is string => value !== 'evil', { identifier: 'NotEvil' })
)

const wordDef = makeInputToolDef({
  name: 'word',
  description: 'Collect a word.',
  renderer: 'text-field',
  title: 'Word'
})

const wordHandler: InputToolHandler = {
  validateCall: params =>
    Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Never))(params),
  validateResponse: data => Schema.decodeUnknownEffect(NotEvil)(data).pipe(Effect.asVoid),
  formatContent: ({ name, data }) => `Word ${name}: ${JSON.stringify(data)}`
}

const inputs = { word: wordHandler }

const wordCall = ToolCall.make({ id: 'call_word', name: 'word', params: {} })

const submitted = (data: Schema.Json, requestId = 'input:word:call_word') =>
  InputResponse.make({
    requestId,
    toolCallId: wordCall.id,
    outcome: 'submitted',
    source: 'user',
    data
  })

const awaitingInput = (events: ReadonlyArray<AgentEvent>) =>
  events.find(event => Predicate.isTagged(event, 'AgentAwaitingInput'))

const completions = (events: ReadonlyArray<AgentEvent>) =>
  events.filter(event => Predicate.isTagged(event, 'ToolExecutionCompleted'))

const recordingExecutorLayer = (calls: Array<ToolCall>) =>
  Layer.succeed(
    ToolExecutor,
    ToolExecutor.of({
      execute: call => {
        calls.push(call)

        return Effect.fail(
          new ToolError({ tool: call.name, cause: 'execution', message: 'must not run' })
        )
      }
    })
  )

const batchLayer = (calls: Array<ToolCall>) =>
  Layer.mergeAll(LoopConfig.defaultLayer, recordingExecutorLayer(calls))

describe('generalized input tools', () => {
  it.effect('validates original call schemas before prompting or accepting responses', () =>
    Effect.gen(function* () {
      const registration = makeInputTool({
        name: 'word',
        description: 'Collect a word.',
        response: NotEvil,
        callParameters: Schema.Struct({ context: NotEvil })
      })

      const toolSet = yield* resolveTools([{ id: 'input', tools: [registration] }], {})

      for (const params of [{}, { context: 'evil' }]) {
        const prepared = yield* prepareToolBatch({
          tools: toolSet.tools,
          inputs: toolSet.inputs,
          calls: [ToolCall.make({ id: wordCall.id, name: 'word', params })],
          responses: [submitted('kind')]
        })

        expect(prepared.pendingRequests).toEqual([])
        expect(prepared.callsToExecute).toEqual([])
        expect(prepared.resultMessages[0]?.message).toMatchObject({ isError: true })
      }

      const valid = yield* prepareToolBatch({
        tools: toolSet.tools,
        inputs: toolSet.inputs,
        calls: [ToolCall.make({ id: wordCall.id, name: 'word', params: { context: 'kind' } })],
        responses: []
      })

      expect(valid.pendingRequests).toHaveLength(1)
    })
  )

  it.effect('never replaces settled input or cancellation with stale responses', () =>
    Effect.gen(function* () {
      const cancelled = InputResponse.make({
        requestId: 'input:word:call_word',
        toolCallId: wordCall.id,
        outcome: 'cancelled',
        source: 'user',
        reason: 'not now'
      })

      for (const first of [submitted('kind'), cancelled]) {
        const prepared = yield* prepareToolBatch({
          tools: [wordDef],
          inputs,
          calls: [wordCall],
          responses: [submitted('evil'), first, submitted('different'), submitted('evil')]
        })

        expect(prepared.pendingRequests).toEqual([])
        expect(prepared.resultMessages[0]?.message).toMatchObject({
          structuredContent: { outcome: first.outcome }
        })

        if (first.outcome === 'submitted') {
          expect(prepared.resultMessages[0]?.message).toMatchObject({
            structuredContent: { data: 'kind' }
          })
        }
      }
    })
  )

  it.effect('pends input calls and resumes with validated data', () =>
    Effect.gen(function* () {
      const pausedChunk = yield* run({
        messages: [UserMessage.make({ content: 'give me a word' })],
        systemPrompt: 'Collect a word.',
        tools: [wordDef],
        inputs,
        model: 'faux'
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(
            FauxProvider.layer(Reply.toolCall(wordCall)),
            TestToolExecutor.layer({})
          ).pipe(Layer.provideMerge(BaseLayer))
        )
      )

      const paused = Array.from(pausedChunk)

      expect(paused.map(event => event._tag)).toContain('InputRequested')

      expect(paused.map(event => event._tag)).toContain('AgentAwaitingInput')

      const awaiting = awaitingInput(paused)

      if (!Predicate.isTagged(awaiting, 'AgentAwaitingInput')) {
        throw new Error('Expected AgentAwaitingInput')
      }

      expect(awaiting.requests[0]).toMatchObject({
        _tag: 'InputRequest',
        requestId: 'input:word:call_word',
        toolCallId: 'call_word'
      })

      const requests: Array<LLMRequest> = []

      const resumedChunk = yield* run({
        messages: [UserMessage.make({ content: 'give me a word' })],
        systemPrompt: 'Collect a word.',
        tools: [wordDef],
        inputs,
        hitlResponses: [submitted('kind')],
        model: 'faux'
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(
            FauxProvider.layerWithRequests({
              responses: [Reply.toolCall(wordCall), Reply.text('thanks')],
              requests
            }),
            TestToolExecutor.layer({})
          ).pipe(Layer.provideMerge(BaseLayer))
        )
      )

      const resumed = Array.from(resumedChunk)

      expect(resumed.map(event => event._tag)).toContain('InputSubmitted')

      expect(resumed.map(event => event._tag)).toContain('AgentEnd')

      const resultMessage = requests[1]?.messages.at(-1)

      if (!Predicate.isTagged(resultMessage, 'ToolResult')) {
        throw new Error('Expected tool result message')
      }

      expect(resultMessage.toolCallId).toBe('call_word')

      expect(resultMessage.content).toBe('Word word: "kind"')

      expect(resultMessage.structuredContent).toEqual({
        type: 'input_response',
        name: 'word',
        outcome: 'submitted',
        data: 'kind',
        source: 'user'
      })
    })
  )

  it.effect('fences executable siblings while input is pending', () =>
    Effect.gen(function* () {
      const executed: Array<ToolCall> = []

      const sibling = ToolCall.make({ id: 'call_search', name: 'web_search', params: {} })

      const searchDef = ToolDef.make({
        name: 'web_search',
        description: 'Search.',
        parameters: {}
      })

      const eventsChunk = yield* runToolBatch({
        tools: [wordDef, searchDef],
        inputs,
        calls: [wordCall, sibling]
      }).pipe(Stream.runCollect, Effect.provide(batchLayer(executed)))

      const events = Array.from(eventsChunk)

      expect(executed).toEqual([])

      expect(events.map(event => event._tag)).toContain('AgentAwaitingInput')

      expect(completions(events)).toEqual([])

      const awaiting = awaitingInput(events)

      if (!Predicate.isTagged(awaiting, 'AgentAwaitingInput')) {
        throw new Error('Expected AgentAwaitingInput')
      }

      expect(awaiting.requests.map(request => request.toolCallId)).toEqual(['call_word'])
    })
  )

  it.effect('keeps invalid payloads pending and accepts corrected resubmission', () =>
    Effect.gen(function* () {
      const executed: Array<ToolCall> = []

      const invalidChunk = yield* runToolBatch({
        tools: [wordDef],
        inputs,
        calls: [wordCall],
        hitlResponses: [submitted('evil')]
      }).pipe(Stream.runCollect, Effect.provide(batchLayer(executed)))

      const invalidEvents = Array.from(invalidChunk)

      expect(executed).toEqual([])

      expect(completions(invalidEvents)).toEqual([])

      const awaiting = awaitingInput(invalidEvents)

      if (!Predicate.isTagged(awaiting, 'AgentAwaitingInput')) {
        throw new Error('Expected AgentAwaitingInput after invalid data')
      }

      expect(awaiting.requests[0]).toMatchObject({
        _tag: 'InputRequest',
        requestId: 'input:word:call_word'
      })

      const correctedChunk = yield* runToolBatch({
        tools: [wordDef],
        inputs,
        calls: [wordCall],
        hitlResponses: [submitted('kind')]
      }).pipe(Stream.runCollect, Effect.provide(batchLayer(executed)))

      const corrected = Array.from(correctedChunk)

      expect(executed).toEqual([])

      const completed = completions(corrected)[0]

      if (completed === undefined) {
        throw new Error('Expected tool completion after correction')
      }

      expect(completed.result.content).toBe('Word word: "kind"')
    })
  )

  it.effect('completes cancellation as a model-visible error', () =>
    Effect.gen(function* () {
      const executed: Array<ToolCall> = []

      const cancelled = InputResponse.make({
        requestId: 'input:word:call_word',
        toolCallId: wordCall.id,
        outcome: 'cancelled',
        source: 'user',
        reason: 'not now'
      })

      const eventsChunk = yield* runToolBatch({
        tools: [wordDef],
        inputs,
        calls: [wordCall],
        hitlResponses: [cancelled]
      }).pipe(Stream.runCollect, Effect.provide(batchLayer(executed)))

      const events = Array.from(eventsChunk)

      expect(executed).toEqual([])

      expect(events.map(event => event._tag)).toContain('InputCancelled')

      const completed = completions(events)[0]

      if (completed === undefined) {
        throw new Error('Expected tool completion')
      }

      expect(completed.result.isError).toBe(true)

      expect(completed.result.content).toBe('Input cancelled: not now')

      expect(awaitingInput(events)).toBeUndefined()
    })
  )

  it.effect('ignores stale and mismatched responses without executing', () =>
    Effect.gen(function* () {
      const executed: Array<ToolCall> = []

      const stale = submitted('kind', 'input:word:other_call')

      const eventsChunk = yield* runToolBatch({
        tools: [wordDef],
        inputs,
        calls: [wordCall],
        hitlResponses: [stale]
      }).pipe(Stream.runCollect, Effect.provide(batchLayer(executed)))

      const events = Array.from(eventsChunk)

      expect(executed).toEqual([])

      expect(completions(events)).toEqual([])

      expect(awaitingInput(events)).not.toBeUndefined()
    })
  )

  it.effect('accepts the first valid response after a corrected resubmission', () =>
    Effect.gen(function* () {
      const executed: Array<ToolCall> = []

      const eventsChunk = yield* runToolBatch({
        tools: [wordDef],
        inputs,
        calls: [wordCall],
        hitlResponses: [submitted('evil'), submitted('kind')]
      }).pipe(Stream.runCollect, Effect.provide(batchLayer(executed)))

      const events = Array.from(eventsChunk)

      expect(executed).toEqual([])

      const completed = completions(events)[0]

      if (completed === undefined) {
        throw new Error('Expected tool completion')
      }

      expect(completed.result.content).toBe('Word word: "kind"')

      expect(awaitingInput(events)).toBeUndefined()
    })
  )

  it.effect('consumes duplicate responses exactly once', () =>
    Effect.gen(function* () {
      const executed: Array<ToolCall> = []

      const response = submitted('kind')

      const eventsChunk = yield* runToolBatch({
        tools: [wordDef],
        inputs,
        calls: [wordCall],
        hitlResponses: [response, response]
      }).pipe(Stream.runCollect, Effect.provide(batchLayer(executed)))

      const events = Array.from(eventsChunk)

      expect(executed).toEqual([])

      expect(completions(events)).toHaveLength(1)
    })
  )

  it.effect('fails closed without a registered handler', () =>
    Effect.gen(function* () {
      const executed: Array<ToolCall> = []

      const eventsChunk = yield* runToolBatch({
        tools: [wordDef],
        calls: [wordCall],
        hitlResponses: [submitted('kind')]
      }).pipe(Stream.runCollect, Effect.provide(batchLayer(executed)))

      const events = Array.from(eventsChunk)

      expect(executed).toEqual([])

      expect(awaitingInput(events)).toBeUndefined()

      const completed = completions(events)[0]

      if (completed === undefined) {
        throw new Error('Expected tool completion')
      }

      expect(completed.result.isError).toBe(true)

      expect(completed.result.content).toBe('Input "word" is unavailable')
    })
  )

  it.effect('fails closed for policy-bearing input defs without prompting', () =>
    Effect.gen(function* () {
      const executed: Array<ToolCall> = []

      const descriptor = wordDef.input

      if (descriptor === undefined) {
        throw new Error('Expected input descriptor')
      }

      const gatedDef = ToolDef.make({
        name: 'word',
        description: 'Collect a word.',
        parameters: {},
        approval: ToolApprovalPolicy.make({ mode: 'manual' }),
        input: descriptor
      })

      const eventsChunk = yield* runToolBatch({
        tools: [gatedDef],
        inputs,
        calls: [wordCall]
      }).pipe(Stream.runCollect, Effect.provide(batchLayer(executed)))

      const events = Array.from(eventsChunk)

      expect(executed).toEqual([])

      expect(events.map(event => event._tag)).not.toContain('ToolApprovalRequested')

      expect(events.map(event => event._tag)).not.toContain('InputRequested')

      expect(awaitingInput(events)).toBeUndefined()

      expect(completions(events)).toHaveLength(1)
    })
  )

  it.effect('shares the sibling fence with legacy questions', () =>
    Effect.gen(function* () {
      const questionDef = ToolDef.make({ name: 'question', description: 'Ask.', parameters: {} })

      const questionCall = ToolCall.make({
        id: 'call_question',
        name: 'question',
        params: {
          questions: [{ id: 'choice', prompt: 'Pick one', options: [{ id: 'a', label: 'A' }] }]
        }
      })

      const paused = yield* prepareToolBatch({
        tools: [questionDef, wordDef],
        responses: [],
        calls: [questionCall, wordCall],
        inputs
      })

      expect(paused.pendingRequests).toHaveLength(2)

      expect(paused.callsToExecute).toEqual([])

      expect(paused.resultMessages).toEqual([])

      const answer = QuestionResponse.make({
        requestId: 'question:call_question',
        toolCallId: questionCall.id,
        outcome: 'answered',
        source: 'user',
        answers: [QuestionAnswer.make({ questionId: 'choice', optionIds: ['a'] })]
      })

      const resumed = yield* prepareToolBatch({
        tools: [questionDef, wordDef],
        responses: [answer, submitted('kind')],
        calls: [questionCall, wordCall],
        inputs
      })

      expect(resumed.pendingRequests).toEqual([])

      expect(resumed.callsToExecute).toEqual([])

      expect(resumed.resultMessages).toHaveLength(2)
    })
  )
})
