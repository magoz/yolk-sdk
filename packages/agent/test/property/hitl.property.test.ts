import { Effect, Layer, Schema, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  type AgentEvent,
  HitlResponseSource,
  QuestionResponse,
  QuestionResponseOutcome,
  ToolApprovalDecision,
  ToolApprovalPolicy,
  ToolApprovalResponse,
  ToolCall,
  ToolDef
} from '@yolk-sdk/agent/protocol'
import { LoopConfig, runToolBatch, type AgentLoopError } from '../../src/loop'
import { TestToolExecutor } from '../../src/loop/testing'
import { propertyOptions } from './property-options'

const manualWeatherTool = ToolDef.make({
  name: 'weather',
  description: 'Get weather.',
  parameters: {},
  approval: ToolApprovalPolicy.make({ mode: 'manual', reason: 'external lookup' })
})

const weatherCall = ToolCall.make({
  id: 'call_1',
  name: 'weather',
  params: { city: 'Paris' }
})

const questionTool = ToolDef.make({
  name: 'question',
  description: 'Ask.',
  parameters: {}
})

const questionCall = ToolCall.make({
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

const approvalCase = Schema.Struct({
  decision: ToolApprovalDecision,
  source: HitlResponseSource,
  reason: Schema.optional(Schema.String)
})

const approvalCaseArbitrary = Schema.toArbitrary(approvalCase)

const mismatchedApprovalCase = Schema.Struct({
  approval: approvalCase,
  mismatch: Schema.Literals(['requestId', 'toolCallId'])
})

const mismatchedApprovalCaseArbitrary = Schema.toArbitrary(mismatchedApprovalCase)

const mismatchedQuestionCase = Schema.Struct({
  outcome: QuestionResponseOutcome,
  source: HitlResponseSource,
  mismatch: Schema.Literals(['requestId', 'toolCallId'])
})

const mismatchedQuestionCaseArbitrary = Schema.toArbitrary(mismatchedQuestionCase)

const testLayer = Layer.mergeAll(
  LoopConfig.defaultLayer,
  TestToolExecutor.layer({ weather: '72F' })
)

const collectAgentEvents = <E, R>(stream: Stream.Stream<AgentEvent, E, R>) =>
  Effect.gen(function* () {
    const events: Array<AgentEvent> = []

    yield* stream.pipe(
      Stream.runForEach(event =>
        Effect.sync(() => {
          events.push(event)
        })
      )
    )

    return events
  })

const matchingApprovalResponse = (input: typeof approvalCase.Type) => {
  const base = {
    requestId: 'approval:call_1',
    toolCallId: 'call_1',
    decision: input.decision,
    source: input.source
  }

  return ToolApprovalResponse.make(
    input.reason === undefined ? base : { ...base, reason: input.reason }
  )
}

const staleApprovalResponse = (input: typeof approvalCase.Type) => {
  const base = {
    requestId: 'approval:stale',
    toolCallId: 'stale',
    decision: input.decision,
    source: input.source
  }

  return ToolApprovalResponse.make(
    input.reason === undefined ? base : { ...base, reason: input.reason }
  )
}

const mismatchedApprovalResponse = (input: typeof mismatchedApprovalCase.Type) => {
  const base = {
    requestId: input.mismatch === 'requestId' ? 'approval:stale' : 'approval:call_1',
    toolCallId: input.mismatch === 'toolCallId' ? 'stale' : 'call_1',
    decision: input.approval.decision,
    source: input.approval.source
  }

  return ToolApprovalResponse.make(
    input.approval.reason === undefined ? base : { ...base, reason: input.approval.reason }
  )
}

const mismatchedQuestionResponse = (input: typeof mismatchedQuestionCase.Type) =>
  QuestionResponse.make({
    requestId: input.mismatch === 'requestId' ? 'question:stale' : 'question:call_question',
    toolCallId: input.mismatch === 'toolCallId' ? 'stale' : 'call_question',
    outcome: input.outcome,
    source: input.source
  })

const runManualWeatherBatch = (
  response: ToolApprovalResponse
): Effect.Effect<ReadonlyArray<AgentEvent>, AgentLoopError> =>
  collectAgentEvents(
    runToolBatch({
      calls: [weatherCall],
      tools: [manualWeatherTool],
      hitlResponses: [response],
      model: 'faux'
    })
  ).pipe(Effect.provide(testLayer))

const runQuestionBatch = (
  response: QuestionResponse
): Effect.Effect<ReadonlyArray<AgentEvent>, AgentLoopError> =>
  collectAgentEvents(
    runToolBatch({
      calls: [questionCall],
      tools: [questionTool],
      hitlResponses: [response],
      model: 'faux'
    })
  ).pipe(Effect.provide(testLayer))

const toolExecutionStartedIds = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap(event => (event._tag === 'ToolExecutionStarted' ? [event.call.id] : []))

describe('HITL property tests', () => {
  it.effect.prop(
    'manual approval responses execute iff approved',
    [approvalCaseArbitrary],
    ([input]) =>
      Effect.gen(function* () {
        const events = yield* runManualWeatherBatch(matchingApprovalResponse(input))
        const tags = events.map(event => event._tag)

        expect(tags).not.toContain('AgentAwaitingInput')

        if (input.decision === 'approved') {
          expect(tags).toContain('ToolApprovalGranted')
          expect(tags).not.toContain('ToolApprovalDenied')
          expect(toolExecutionStartedIds(events)).toEqual(['call_1'])
        } else {
          expect(tags).toContain('ToolApprovalDenied')
          expect(tags).not.toContain('ToolApprovalGranted')
          expect(toolExecutionStartedIds(events)).toEqual([])
        }
      }),
    propertyOptions
  )

  it.effect.prop(
    'stale approval responses never execute pending tools',
    [approvalCaseArbitrary],
    ([input]) =>
      Effect.gen(function* () {
        const events = yield* runManualWeatherBatch(staleApprovalResponse(input))
        const tags = events.map(event => event._tag)

        expect(tags).toContain('ToolApprovalRequested')
        expect(tags).toContain('AgentAwaitingInput')
        expect(tags).not.toContain('ToolApprovalGranted')
        expect(tags).not.toContain('ToolApprovalDenied')
        expect(toolExecutionStartedIds(events)).toEqual([])
      }),
    propertyOptions
  )

  it.effect.prop(
    'approval responses with mismatched ids never execute pending tools',
    [mismatchedApprovalCaseArbitrary],
    ([input]) =>
      Effect.gen(function* () {
        const events = yield* runManualWeatherBatch(mismatchedApprovalResponse(input))
        const tags = events.map(event => event._tag)

        expect(tags).toContain('ToolApprovalRequested')
        expect(tags).toContain('AgentAwaitingInput')
        expect(tags).not.toContain('ToolApprovalGranted')
        expect(tags).not.toContain('ToolApprovalDenied')
        expect(toolExecutionStartedIds(events)).toEqual([])
      }),
    propertyOptions
  )

  it.effect.prop(
    'question responses with mismatched ids never answer pending questions',
    [mismatchedQuestionCaseArbitrary],
    ([input]) =>
      Effect.gen(function* () {
        const events = yield* runQuestionBatch(mismatchedQuestionResponse(input))
        const tags = events.map(event => event._tag)

        expect(tags).toContain('QuestionRequested')
        expect(tags).toContain('AgentAwaitingInput')
        expect(tags).not.toContain('QuestionAnswered')
        expect(tags).not.toContain('QuestionCancelled')
      }),
    propertyOptions
  )
})
