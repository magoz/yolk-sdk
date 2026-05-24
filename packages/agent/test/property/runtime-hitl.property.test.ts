import { Effect, Layer, Schema, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  HitlResponseSource,
  QuestionResponse,
  QuestionResponseOutcome,
  ToolCall,
  ToolApprovalDecision,
  ToolApprovalPolicy,
  ToolApprovalResponse,
  ToolDef,
  UserMessage
} from '@yolk-sdk/agent/protocol'
import { ContextTransformer, LLMDone, LLMToolCall, LoopConfig, type LLMRequest } from '@yolk-sdk/agent/loop'
import { FauxProvider, Reply, TestToolExecutor } from '@yolk-sdk/agent/loop/testing'
import {
  makeInMemorySessionEventStoreLayer,
  runRuntime,
  SessionEventStore,
  type RuntimeConfig
} from '../../src/runtime'
import { propertyOptions } from './property-options'

const approvalCase = Schema.Struct({
  decision: ToolApprovalDecision,
  source: HitlResponseSource,
  mismatch: Schema.Literals(['requestId', 'toolCallId'])
})

const approvalCaseArbitrary = Schema.toArbitrary(approvalCase)

const approvalCommand = Schema.Struct({
  kind: Schema.Literals(['valid', 'stale', 'mismatchedRequestId', 'mismatchedToolCallId']),
  decision: ToolApprovalDecision,
  source: HitlResponseSource
})

const approvalCommandsArbitrary = Schema.toArbitrary(Schema.Array(approvalCommand))

const questionCase = Schema.Struct({
  outcome: QuestionResponseOutcome,
  source: HitlResponseSource,
  mismatch: Schema.Literals(['requestId', 'toolCallId'])
})

const questionCaseArbitrary = Schema.toArbitrary(questionCase)

const questionCommand = Schema.Struct({
  kind: Schema.Literals(['valid', 'stale', 'mismatchedRequestId', 'mismatchedToolCallId']),
  outcome: QuestionResponseOutcome,
  source: HitlResponseSource
})

const questionCommandsArbitrary = Schema.toArbitrary(Schema.Array(questionCommand))

const mixedFirstResponse = Schema.Struct({
  first: Schema.Literals(['approval', 'question']),
  decision: ToolApprovalDecision,
  outcome: QuestionResponseOutcome,
  source: HitlResponseSource
})

const mixedFirstResponseArbitrary = Schema.toArbitrary(mixedFirstResponse)

const weatherTool = ToolDef.make({
  name: 'weather',
  description: 'Get weather.',
  parameters: {},
  approval: ToolApprovalPolicy.make({ mode: 'manual', reason: 'external lookup' })
})

const questionTool = ToolDef.make({
  name: 'question',
  description: 'Ask.',
  parameters: {}
})

const runtimeConfig: RuntimeConfig = {
  systemPrompt: 'Be brief.',
  tools: [weatherTool],
  model: 'faux'
}

const questionRuntimeConfig: RuntimeConfig = {
  systemPrompt: 'Ask one question.',
  tools: [questionTool],
  model: 'faux'
}

const makeLayer = (requests: Array<LLMRequest>) =>
  Layer.mergeAll(
    ContextTransformer.identity,
    LoopConfig.defaultLayer,
    FauxProvider.layerWithRequests({
      responses: [
        Reply.toolCall({ id: 'call_1', name: 'weather', params: { city: 'Paris' } }),
        Reply.text('sunny')
      ],
      requests
    }),
    TestToolExecutor.layer({ weather: '72F' }),
    makeInMemorySessionEventStoreLayer()
  )

const makeQuestionLayer = (requests: Array<LLMRequest>) =>
  Layer.mergeAll(
    ContextTransformer.identity,
    LoopConfig.defaultLayer,
    FauxProvider.layerWithRequests({
      responses: [
        Reply.toolCall({
          id: 'call_question',
          name: 'question',
          params: {
            questions: [
              {
                id: 'choice',
                prompt: 'Pick one',
                options: [{ id: 'a', label: 'A' }]
              }
            ]
          }
        }),
        Reply.text('thanks')
      ],
      requests
    }),
    TestToolExecutor.layer({}),
    makeInMemorySessionEventStoreLayer()
  )

const makeMixedLayer = (requests: Array<LLMRequest>) =>
  Layer.mergeAll(
    ContextTransformer.identity,
    LoopConfig.defaultLayer,
    FauxProvider.layerWithRequests({
      responses: [
        {
          events: [
            LLMToolCall.make({
              call: ToolCall.make({ id: 'call_1', name: 'weather', params: { city: 'Paris' } })
            }),
            LLMToolCall.make({
              call: ToolCall.make({
                id: 'call_question',
                name: 'question',
                params: {
                  questions: [
                    {
                      id: 'choice',
                      prompt: 'Pick one',
                      options: [{ id: 'a', label: 'A' }]
                    }
                  ]
                }
              })
            }),
            LLMDone.make({ stopReason: 'tool_use' })
          ]
        },
        Reply.text('done')
      ],
      requests
    }),
    TestToolExecutor.layer({ weather: '72F' }),
    makeInMemorySessionEventStoreLayer()
  )

const mixedRuntimeConfig: RuntimeConfig = {
  systemPrompt: 'Use tools.',
  tools: [weatherTool, questionTool],
  model: 'faux'
}

const appendWeatherInput = () =>
  runRuntime(
    {
      _tag: 'AppendInput',
      sessionId: 'session_1',
      input: UserMessage.make({ content: 'weather?' }),
      runId: 'run_1'
    },
    runtimeConfig
  ).pipe(Stream.runCollect)

const appendQuestionInput = () =>
  runRuntime(
    {
      _tag: 'AppendInput',
      sessionId: 'session_1',
      input: UserMessage.make({ content: 'ask me' }),
      runId: 'run_1'
    },
    questionRuntimeConfig
  ).pipe(Stream.runCollect)

const appendMixedInput = () =>
  runRuntime(
    {
      _tag: 'AppendInput',
      sessionId: 'session_1',
      input: UserMessage.make({ content: 'weather and ask' }),
      runId: 'run_1'
    },
    mixedRuntimeConfig
  ).pipe(Stream.runCollect)

const expectSessionConflict = (result: unknown) => {
  expect(result).toMatchObject({
    _tag: 'Failure',
    failure: { _tag: 'SessionConflictError', sessionId: 'session_1' }
  })
}

const expectConflictNoMutation = (input: {
  readonly result: unknown
  readonly before: unknown
  readonly after: unknown
}) => {
  expectSessionConflict(input.result)
  expect(input.after).toEqual(input.before)
}

const mismatchedResponse = (input: typeof approvalCase.Type) =>
  ToolApprovalResponse.make({
    requestId: input.mismatch === 'requestId' ? 'approval:stale' : 'approval:call_1',
    toolCallId: input.mismatch === 'toolCallId' ? 'stale' : 'call_1',
    decision: input.decision,
    source: input.source
  })

const matchingResponse = (input: typeof approvalCase.Type) =>
  ToolApprovalResponse.make({
    requestId: 'approval:call_1',
    toolCallId: 'call_1',
    decision: input.decision,
    source: input.source
  })

const commandResponse = (input: typeof approvalCommand.Type) => {
  const requestId =
    input.kind === 'stale' || input.kind === 'mismatchedRequestId'
      ? 'approval:stale'
      : 'approval:call_1'
  const toolCallId =
    input.kind === 'stale' || input.kind === 'mismatchedToolCallId'
      ? 'stale'
      : 'call_1'

  return ToolApprovalResponse.make({
    requestId,
    toolCallId,
    decision: input.decision,
    source: input.source
  })
}

const mismatchedQuestionResponse = (input: typeof questionCase.Type) =>
  QuestionResponse.make({
    requestId: input.mismatch === 'requestId' ? 'question:stale' : 'question:call_question',
    toolCallId: input.mismatch === 'toolCallId' ? 'stale' : 'call_question',
    outcome: input.outcome,
    source: input.source
  })

const matchingQuestionResponse = (input: typeof questionCase.Type) =>
  QuestionResponse.make({
    requestId: 'question:call_question',
    toolCallId: 'call_question',
    outcome: input.outcome,
    source: input.source
  })

const questionCommandResponse = (input: typeof questionCommand.Type) => {
  const requestId =
    input.kind === 'stale' || input.kind === 'mismatchedRequestId'
      ? 'question:stale'
      : 'question:call_question'
  const toolCallId =
    input.kind === 'stale' || input.kind === 'mismatchedToolCallId'
      ? 'stale'
      : 'call_question'

  return QuestionResponse.make({
    requestId,
    toolCallId,
    outcome: input.outcome,
    source: input.source
  })
}

const mixedApprovalResponse = (input: typeof mixedFirstResponse.Type) =>
  ToolApprovalResponse.make({
    requestId: 'approval:call_1',
    toolCallId: 'call_1',
    decision: input.decision,
    source: input.source
  })

const mixedQuestionResponse = (input: typeof mixedFirstResponse.Type) =>
  QuestionResponse.make({
    requestId: 'question:call_question',
    toolCallId: 'call_question',
    outcome: input.outcome,
    source: input.source
  })

const firstMixedResponse = (input: typeof mixedFirstResponse.Type) =>
  input.first === 'approval' ? mixedApprovalResponse(input) : mixedQuestionResponse(input)

const secondMixedResponse = (input: typeof mixedFirstResponse.Type) =>
  input.first === 'approval' ? mixedQuestionResponse(input) : mixedApprovalResponse(input)

describe('runtime HITL property tests', () => {
  it.effect.prop(
    'mismatched approval responses do not mutate session logs',
    [approvalCaseArbitrary],
    ([input]) => {
      const requests: Array<LLMRequest> = []

      return Effect.gen(function* () {
        yield* appendWeatherInput()

        const store = yield* SessionEventStore
        const before = yield* store.load('session_1')

        const result = yield* runRuntime(
          {
            _tag: 'AppendHitlResponse',
            sessionId: 'session_1',
            response: mismatchedResponse(input),
            runId: 'run_2',
            expectedRevision: before.revision
          },
          runtimeConfig
        ).pipe(Stream.runCollect, Effect.result)

        const after = yield* store.load('session_1')

        expectConflictNoMutation({ result, before, after })
        expect(requests).toHaveLength(1)
      }).pipe(Effect.provide(makeLayer(requests)))
    },
    propertyOptions
  )

  it.effect.prop(
    'mismatched question responses do not mutate session logs',
    [questionCaseArbitrary],
    ([input]) => {
      const requests: Array<LLMRequest> = []

      return Effect.gen(function* () {
        yield* appendQuestionInput()

        const store = yield* SessionEventStore
        const before = yield* store.load('session_1')
        const result = yield* runRuntime(
          {
            _tag: 'AppendHitlResponse',
            sessionId: 'session_1',
            response: mismatchedQuestionResponse(input),
            runId: 'run_2',
            expectedRevision: before.revision
          },
          questionRuntimeConfig
        ).pipe(Stream.runCollect, Effect.result)
        const after = yield* store.load('session_1')

        expectConflictNoMutation({ result, before, after })
        expect(requests).toHaveLength(1)
      }).pipe(Effect.provide(makeQuestionLayer(requests)))
    },
    propertyOptions
  )

  it.effect.prop(
    'duplicate terminal approval responses do not mutate completed sessions',
    [approvalCaseArbitrary],
    ([input]) => {
      const requests: Array<LLMRequest> = []

      return Effect.gen(function* () {
        yield* appendWeatherInput()

        const response = matchingResponse(input)
        const store = yield* SessionEventStore
        const beforeResponse = yield* store.load('session_1')

        yield* runRuntime(
          {
            _tag: 'AppendHitlResponse',
            sessionId: 'session_1',
            response,
            runId: 'run_2',
            expectedRevision: beforeResponse.revision
          },
          runtimeConfig
        ).pipe(Stream.runCollect)

        const completed = yield* store.load('session_1')
        const result = yield* runRuntime(
          {
            _tag: 'AppendHitlResponse',
            sessionId: 'session_1',
            response,
            runId: 'run_3',
            expectedRevision: completed.revision
          },
          runtimeConfig
        ).pipe(Stream.runCollect, Effect.result)
        const afterDuplicate = yield* store.load('session_1')

        expectConflictNoMutation({ result, before: completed, after: afterDuplicate })
      }).pipe(Effect.provide(makeLayer(requests)))
    },
    propertyOptions
  )

  it.effect.prop(
    'duplicate terminal question responses do not mutate completed sessions',
    [questionCaseArbitrary],
    ([input]) => {
      const requests: Array<LLMRequest> = []

      return Effect.gen(function* () {
        yield* appendQuestionInput()

        const response = matchingQuestionResponse(input)
        const store = yield* SessionEventStore
        const beforeResponse = yield* store.load('session_1')

        yield* runRuntime(
          {
            _tag: 'AppendHitlResponse',
            sessionId: 'session_1',
            response,
            runId: 'run_2',
            expectedRevision: beforeResponse.revision
          },
          questionRuntimeConfig
        ).pipe(Stream.runCollect)

        const completed = yield* store.load('session_1')
        const result = yield* runRuntime(
          {
            _tag: 'AppendHitlResponse',
            sessionId: 'session_1',
            response,
            runId: 'run_3',
            expectedRevision: completed.revision
          },
          questionRuntimeConfig
        ).pipe(Stream.runCollect, Effect.result)
        const afterDuplicate = yield* store.load('session_1')

        expectConflictNoMutation({ result, before: completed, after: afterDuplicate })
      }).pipe(Effect.provide(makeQuestionLayer(requests)))
    },
    propertyOptions
  )

  it.effect.prop(
    'approval response command sequences preserve session invariants',
    [approvalCommandsArbitrary],
    ([commands]) => {
      const requests: Array<LLMRequest> = []

      return Effect.gen(function* () {
        yield* appendWeatherInput()

        const store = yield* SessionEventStore
        let pending = true
        let runIndex = 2

        for (const command of commands) {
          const before = yield* store.load('session_1')
          const result = yield* runRuntime(
            {
              _tag: 'AppendHitlResponse',
              sessionId: 'session_1',
              response: commandResponse(command),
              runId: `run_${runIndex}`,
              expectedRevision: before.revision
            },
            runtimeConfig
          ).pipe(Stream.runCollect, Effect.result)
          const after = yield* store.load('session_1')
          const shouldAccept = pending && command.kind === 'valid'

          if (shouldAccept) {
            expect(result).toMatchObject({ _tag: 'Success' })
            expect(after.revision).toBeGreaterThan(before.revision)
            expect(after.events.map(event => event.event._tag)).toContain('RunCompleted')
            pending = false
          } else {
            expectConflictNoMutation({ result, before, after })
          }

          runIndex += 1
        }
      }).pipe(Effect.provide(makeLayer(requests)))
    },
    propertyOptions
  )

  it.effect.prop(
    'question response command sequences preserve session invariants',
    [questionCommandsArbitrary],
    ([commands]) => {
      const requests: Array<LLMRequest> = []

      return Effect.gen(function* () {
        yield* appendQuestionInput()

        const store = yield* SessionEventStore
        let pending = true
        let runIndex = 2

        for (const command of commands) {
          const before = yield* store.load('session_1')
          const result = yield* runRuntime(
            {
              _tag: 'AppendHitlResponse',
              sessionId: 'session_1',
              response: questionCommandResponse(command),
              runId: `run_${runIndex}`,
              expectedRevision: before.revision
            },
            questionRuntimeConfig
          ).pipe(Stream.runCollect, Effect.result)
          const after = yield* store.load('session_1')
          const shouldAccept = pending && command.kind === 'valid'

          if (shouldAccept) {
            expect(result).toMatchObject({ _tag: 'Success' })
            expect(after.revision).toBeGreaterThan(before.revision)
            expect(after.events.map(event => event.event._tag)).toContain('RunCompleted')
            pending = false
          } else {
            expectConflictNoMutation({ result, before, after })
          }

          runIndex += 1
        }
      }).pipe(Effect.provide(makeQuestionLayer(requests)))
    },
    propertyOptions
  )

  it.effect.prop(
    'mixed pending HITL requests remain isolated until all responses arrive',
    [mixedFirstResponseArbitrary],
    ([input]) => {
      const requests: Array<LLMRequest> = []

      return Effect.gen(function* () {
        yield* appendMixedInput()

        const store = yield* SessionEventStore
        const initial = yield* store.load('session_1')
        const initialLast = initial.events.at(-1)?.event
        if (initialLast?._tag !== 'RunAwaitingInput') {
          throw new Error('Expected mixed run to await input')
        }
        expect(initialLast.requests).toHaveLength(2)

        yield* runRuntime(
          {
            _tag: 'AppendHitlResponse',
            sessionId: 'session_1',
            response: firstMixedResponse(input),
            runId: 'run_2',
            expectedRevision: initial.revision
          },
          mixedRuntimeConfig
        ).pipe(Stream.runCollect)

        const afterFirst = yield* store.load('session_1')
        const afterFirstLast = afterFirst.events.at(-1)?.event
        if (afterFirstLast?._tag !== 'RunAwaitingInput') {
          throw new Error('Expected sibling request to remain pending')
        }
        expect(afterFirstLast.requests).toHaveLength(1)

        const duplicateResult = yield* runRuntime(
          {
            _tag: 'AppendHitlResponse',
            sessionId: 'session_1',
            response: firstMixedResponse(input),
            runId: 'run_3',
            expectedRevision: afterFirst.revision
          },
          mixedRuntimeConfig
        ).pipe(Stream.runCollect, Effect.result)
        const afterDuplicate = yield* store.load('session_1')
        expectConflictNoMutation({ result: duplicateResult, before: afterFirst, after: afterDuplicate })

        yield* runRuntime(
          {
            _tag: 'AppendHitlResponse',
            sessionId: 'session_1',
            response: secondMixedResponse(input),
            runId: 'run_4',
            expectedRevision: afterFirst.revision
          },
          mixedRuntimeConfig
        ).pipe(Stream.runCollect)

        const completed = yield* store.load('session_1')
        expect(completed.events.map(event => event.event._tag)).toContain('RunCompleted')
      }).pipe(Effect.provide(makeMixedLayer(requests)))
    },
    propertyOptions
  )
})
