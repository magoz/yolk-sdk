import { Arbitrary } from 'effect/unstable/arbitrary'
import { Effect, Layer, Match, Option, Predicate, Result, Schema, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  HitlResponseSource,
  InputResponse,
  InteractionResponse,
  type HitlResponse,
  type HitlRequest,
  QuestionResponse,
  QuestionResponseOutcome,
  ToolCall,
  ToolApprovalDecision,
  ToolApprovalPolicy,
  ToolApprovalResponse,
  ToolDef,
  UserMessage
} from '@yolk-sdk/agent/protocol'
import {
  ContextTransformer,
  LLMDone,
  LLMToolCall,
  LoopConfig,
  type LLMRequest
} from '@yolk-sdk/agent/loop'
import { FauxProvider, Reply, TestToolExecutor } from '@yolk-sdk/agent/loop/testing'
import {
  makeInMemorySessionEventStoreLayer,
  runRuntime,
  SessionEventStore,
  type RuntimeConfig,
  type RuntimeSessionEventLog
} from '../../src/runtime'
import { RuntimeRequest } from '../../src/runtime/run-runtime.ts'
import { propertyOptions } from './property-options'

const approvalCase = Schema.Struct({
  decision: ToolApprovalDecision,
  source: HitlResponseSource,
  mismatch: Schema.Literals(['requestId', 'toolCallId'])
})

const approvalCaseArbitrary = Arbitrary.schema(approvalCase)

const approvalCommand = Schema.Struct({
  kind: Schema.Literals(['valid', 'stale', 'mismatchedRequestId', 'mismatchedToolCallId']),
  decision: ToolApprovalDecision,
  source: HitlResponseSource
})

const approvalCommandsArbitrary = Arbitrary.schema(Schema.Array(approvalCommand))

const questionCase = Schema.Struct({
  outcome: QuestionResponseOutcome,
  source: HitlResponseSource,
  mismatch: Schema.Literals(['requestId', 'toolCallId'])
})

const questionCaseArbitrary = Arbitrary.schema(questionCase)

const questionCommand = Schema.Struct({
  kind: Schema.Literals(['valid', 'stale', 'mismatchedRequestId', 'mismatchedToolCallId']),
  outcome: QuestionResponseOutcome,
  source: HitlResponseSource
})

const questionCommandsArbitrary = Arbitrary.schema(Schema.Array(questionCommand))

const mixedFirstResponse = Schema.Struct({
  first: Schema.Literals(['approval', 'question']),
  decision: ToolApprovalDecision,
  outcome: QuestionResponseOutcome,
  source: HitlResponseSource
})

const mixedFirstResponseArbitrary = Arbitrary.schema(mixedFirstResponse)

const stateMachineCommand = Schema.Struct({
  kind: Schema.Literals([
    'appendInput',
    'validApproval',
    'validQuestion',
    'staleApproval',
    'staleQuestion',
    'duplicateLast'
  ]),
  decision: ToolApprovalDecision,
  outcome: QuestionResponseOutcome,
  source: HitlResponseSource
})

const stateMachineCommandsArbitrary = Arbitrary.schema(Schema.Array(stateMachineCommand))

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

const mixedAwaitingResponse = {
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
}

const stateMachineResponses = Array.from({ length: 96 }, (_, index) =>
  index % 2 === 0 ? mixedAwaitingResponse : Reply.text(`done_${index}`)
)

const makeStateMachineLayer = (requests: Array<LLMRequest>) =>
  Layer.mergeAll(
    ContextTransformer.identity,
    LoopConfig.defaultLayer,
    FauxProvider.layerWithRequests({
      responses: stateMachineResponses,
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
    RuntimeRequest.AppendInput({
      sessionId: 'session_1',
      input: UserMessage.make({ content: 'weather?' }),
      runId: 'run_1'
    }),
    runtimeConfig
  ).pipe(Stream.runCollect)

const appendQuestionInput = () =>
  runRuntime(
    RuntimeRequest.AppendInput({
      sessionId: 'session_1',
      input: UserMessage.make({ content: 'ask me' }),
      runId: 'run_1'
    }),
    questionRuntimeConfig
  ).pipe(Stream.runCollect)

const appendMixedInput = () =>
  runRuntime(
    RuntimeRequest.AppendInput({
      sessionId: 'session_1',
      input: UserMessage.make({ content: 'weather and ask' }),
      runId: 'run_1'
    }),
    mixedRuntimeConfig
  ).pipe(Stream.runCollect)

const expectSessionConflict = (result: Result.Result<unknown, unknown>) => {
  expect(Result.isFailure(result)).toBe(true)

  if (!Result.isFailure(result)) {
    return
  }

  expect(Predicate.isTagged(result.failure, 'SessionConflictError')).toBe(true)

  if (Predicate.isTagged(result.failure, 'SessionConflictError')) {
    expect(result.failure).toMatchObject({ sessionId: 'session_1' })
  }
}

const expectConflictNoMutation = (input: {
  readonly result: Result.Result<unknown, unknown>
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
    input.kind === 'stale' || input.kind === 'mismatchedToolCallId' ? 'stale' : 'call_1'

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
    input.kind === 'stale' || input.kind === 'mismatchedToolCallId' ? 'stale' : 'call_question'

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

const latestPendingRequests = (log: RuntimeSessionEventLog) => {
  for (const stored of [...log.events].reverse()) {
    const requests = Match.value(stored.event).pipe(
      Match.tag('RunAwaitingInput', current => Option.some(current.requests)),
      Match.tag('RunCompleted', 'RunFailed', 'RunInterrupted', () => Option.some([])),
      Match.tag('HitlResponseAppended', 'InputAppended', 'RunStarted', () => Option.none()),
      Match.exhaustive
    )

    if (Option.isSome(requests)) {
      return requests.value
    }
  }

  return []
}

const requestMatchesResponseKind = (
  request: HitlRequest,
  kind: 'validApproval' | 'validQuestion'
) =>
  kind === 'validApproval'
    ? Predicate.isTagged(request, 'ToolApprovalRequest')
    : Predicate.isTagged(request, 'QuestionRequest')

const responseMatchesPendingRequest = (response: HitlResponse, request: HitlRequest) =>
  Match.value(response).pipe(
    Match.tag(
      'ToolApprovalResponse',
      current =>
        Predicate.isTagged(request, 'ToolApprovalRequest') &&
        current.requestId === request.requestId &&
        current.toolCallId === request.toolCallId
    ),
    Match.tag(
      'QuestionResponse',
      current =>
        Predicate.isTagged(request, 'QuestionRequest') &&
        current.requestId === request.requestId &&
        current.toolCallId === request.toolCallId
    ),
    Match.tag(
      'InputResponse',
      current =>
        Predicate.isTagged(request, 'InputRequest') &&
        current.requestId === request.requestId &&
        current.toolCallId === request.toolCallId
    ),
    Match.tag(
      'InteractionResponse',
      current =>
        Predicate.isTagged(request, 'InteractionRequest') &&
        current.requestId === request.requestId &&
        current.toolCallId === request.toolCallId
    ),
    Match.exhaustive
  )

const responseForPendingRequest = (
  request: HitlRequest,
  command: typeof stateMachineCommand.Type
): HitlResponse =>
  Match.value(request).pipe(
    Match.tag('ToolApprovalRequest', current =>
      ToolApprovalResponse.make({
        requestId: current.requestId,
        toolCallId: current.toolCallId,
        decision: command.decision,
        source: command.source
      })
    ),
    Match.tag('QuestionRequest', current =>
      QuestionResponse.make({
        requestId: current.requestId,
        toolCallId: current.toolCallId,
        outcome: command.outcome,
        source: command.source
      })
    ),
    Match.tag('InputRequest', current =>
      InputResponse.make({
        requestId: current.requestId,
        toolCallId: current.toolCallId,
        outcome: 'submitted',
        source: command.source,
        data: 'simulated'
      })
    ),
    Match.tag('InteractionRequest', current =>
      InteractionResponse.make({
        requestId: current.requestId,
        toolCallId: current.toolCallId,
        outcome: 'cancelled',
        source: command.source,
        reason: 'simulated'
      })
    ),
    Match.exhaustive
  )

const staleStateMachineResponse = (command: typeof stateMachineCommand.Type): HitlResponse => {
  switch (command.kind) {
    case 'staleApproval':
      return ToolApprovalResponse.make({
        requestId: 'approval:stale',
        toolCallId: 'stale',
        decision: command.decision,
        source: command.source
      })
    case 'staleQuestion':
      return QuestionResponse.make({
        requestId: 'question:stale',
        toolCallId: 'stale',
        outcome: command.outcome,
        source: command.source
      })
    case 'appendInput':
    case 'validApproval':
    case 'validQuestion':
    case 'duplicateLast':
      return ToolApprovalResponse.make({
        requestId: 'approval:stale',
        toolCallId: 'stale',
        decision: command.decision,
        source: command.source
      })
  }
}

const stateMachineResponse = (input: {
  readonly command: typeof stateMachineCommand.Type
  readonly pending: ReadonlyArray<HitlRequest>
  readonly lastAccepted: HitlResponse | undefined
}): HitlResponse | undefined => {
  switch (input.command.kind) {
    case 'validApproval': {
      const request = input.pending.find(item => requestMatchesResponseKind(item, 'validApproval'))

      return request === undefined ? undefined : responseForPendingRequest(request, input.command)
    }

    case 'validQuestion': {
      const request = input.pending.find(item => requestMatchesResponseKind(item, 'validQuestion'))

      return request === undefined ? undefined : responseForPendingRequest(request, input.command)
    }

    case 'staleApproval':
    case 'staleQuestion':
      return staleStateMachineResponse(input.command)
    case 'duplicateLast':
      return input.lastAccepted
    case 'appendInput':
      return undefined
  }
}

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
          RuntimeRequest.AppendHitlResponse({
            sessionId: 'session_1',
            response: mismatchedResponse(input),
            runId: 'run_2',
            expectedRevision: before.revision
          }),
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
          RuntimeRequest.AppendHitlResponse({
            sessionId: 'session_1',
            response: mismatchedQuestionResponse(input),
            runId: 'run_2',
            expectedRevision: before.revision
          }),
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
          RuntimeRequest.AppendHitlResponse({
            sessionId: 'session_1',
            response,
            runId: 'run_2',
            expectedRevision: beforeResponse.revision
          }),
          runtimeConfig
        ).pipe(Stream.runCollect)

        const completed = yield* store.load('session_1')

        const result = yield* runRuntime(
          RuntimeRequest.AppendHitlResponse({
            sessionId: 'session_1',
            response,
            runId: 'run_3',
            expectedRevision: completed.revision
          }),
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
          RuntimeRequest.AppendHitlResponse({
            sessionId: 'session_1',
            response,
            runId: 'run_2',
            expectedRevision: beforeResponse.revision
          }),
          questionRuntimeConfig
        ).pipe(Stream.runCollect)

        const completed = yield* store.load('session_1')

        const result = yield* runRuntime(
          RuntimeRequest.AppendHitlResponse({
            sessionId: 'session_1',
            response,
            runId: 'run_3',
            expectedRevision: completed.revision
          }),
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
            RuntimeRequest.AppendHitlResponse({
              sessionId: 'session_1',
              response: commandResponse(command),
              runId: `run_${runIndex}`,
              expectedRevision: before.revision
            }),
            runtimeConfig
          ).pipe(Stream.runCollect, Effect.result)

          const after = yield* store.load('session_1')
          const shouldAccept = pending && command.kind === 'valid'

          if (shouldAccept) {
            expect(result._tag).toBe('Success')
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
            RuntimeRequest.AppendHitlResponse({
              sessionId: 'session_1',
              response: questionCommandResponse(command),
              runId: `run_${runIndex}`,
              expectedRevision: before.revision
            }),
            questionRuntimeConfig
          ).pipe(Stream.runCollect, Effect.result)

          const after = yield* store.load('session_1')
          const shouldAccept = pending && command.kind === 'valid'

          if (shouldAccept) {
            expect(result._tag).toBe('Success')
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
          RuntimeRequest.AppendHitlResponse({
            sessionId: 'session_1',
            response: firstMixedResponse(input),
            runId: 'run_2',
            expectedRevision: initial.revision
          }),
          mixedRuntimeConfig
        ).pipe(Stream.runCollect)

        const afterFirst = yield* store.load('session_1')
        const afterFirstLast = afterFirst.events.at(-1)?.event

        if (afterFirstLast?._tag !== 'RunAwaitingInput') {
          throw new Error('Expected sibling request to remain pending')
        }

        expect(afterFirstLast.requests).toHaveLength(1)

        const duplicateResult = yield* runRuntime(
          RuntimeRequest.AppendHitlResponse({
            sessionId: 'session_1',
            response: firstMixedResponse(input),
            runId: 'run_3',
            expectedRevision: afterFirst.revision
          }),
          mixedRuntimeConfig
        ).pipe(Stream.runCollect, Effect.result)

        const afterDuplicate = yield* store.load('session_1')
        expectConflictNoMutation({
          result: duplicateResult,
          before: afterFirst,
          after: afterDuplicate
        })

        yield* runRuntime(
          RuntimeRequest.AppendHitlResponse({
            sessionId: 'session_1',
            response: secondMixedResponse(input),
            runId: 'run_4',
            expectedRevision: afterFirst.revision
          }),
          mixedRuntimeConfig
        ).pipe(Stream.runCollect)

        const completed = yield* store.load('session_1')
        expect(completed.events.map(event => event.event._tag)).toContain('RunCompleted')
      }).pipe(Effect.provide(makeMixedLayer(requests)))
    },
    propertyOptions
  )

  it.effect.prop(
    'runtime command sequences only resume current pending HITL requests',
    [stateMachineCommandsArbitrary],
    ([generatedCommands]) => {
      const requests: Array<LLMRequest> = []
      const commands = generatedCommands.slice(0, 32)

      return Effect.gen(function* () {
        const store = yield* SessionEventStore
        let runIndex = 1
        let lastAccepted: HitlResponse | undefined

        for (const command of commands) {
          const before = yield* store.load('session_1').pipe(
            Effect.catchTag('SessionNotFoundError', () =>
              Effect.succeed<RuntimeSessionEventLog>({
                sessionId: 'session_1',
                revision: 0,
                events: []
              })
            )
          )

          if (command.kind === 'appendInput') {
            const result = yield* runRuntime(
              RuntimeRequest.AppendInput({
                sessionId: 'session_1',
                input: UserMessage.make({ content: `input_${runIndex}` }),
                runId: `run_${runIndex}`,
                expectedRevision: before.revision
              }),
              mixedRuntimeConfig
            ).pipe(Stream.runCollect, Effect.result)

            const after = yield* store.load('session_1')

            expect(result._tag).toBe('Success')
            expect(after.revision).toBeGreaterThan(before.revision)
            expect(after.revision).toBe(after.events.length)
            runIndex += 1
          } else {
            const pending = latestPendingRequests(before)

            const response =
              stateMachineResponse({ command, pending, lastAccepted }) ??
              staleStateMachineResponse(command)

            const shouldAccept = pending.some(request =>
              responseMatchesPendingRequest(response, request)
            )

            const result = yield* runRuntime(
              RuntimeRequest.AppendHitlResponse({
                sessionId: 'session_1',
                response,
                runId: `run_${runIndex}`,
                expectedRevision: before.revision
              }),
              mixedRuntimeConfig
            ).pipe(Stream.runCollect, Effect.result)

            const after = yield* store
              .load('session_1')
              .pipe(Effect.catchTag('SessionNotFoundError', () => Effect.succeed(before)))

            if (shouldAccept) {
              expect(result._tag).toBe('Success')
              expect(after.revision).toBeGreaterThan(before.revision)
              expect(after.revision).toBe(after.events.length)
              lastAccepted = response
              runIndex += 1
            } else {
              expectConflictNoMutation({ result, before, after })
            }
          }
        }
      }).pipe(Effect.provide(makeStateMachineLayer(requests)))
    },
    propertyOptions
  )
})
