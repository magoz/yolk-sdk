import { Effect, Layer, Schema, Stream } from 'effect'
import { describe, expect, it } from '@effect/vitest'
import {
  AgentInputUsage,
  AgentOutputUsage,
  AgentUsage,
  ToolCall,
  ToolResult,
  UserMessage,
  type AgentEvent
} from '@yolk-sdk/agent/protocol'
import {
  ContextTransformer,
  LLMDone,
  LLMError,
  LLMProvider,
  LLMProviderToolResult,
  LLMReasoningDelta,
  LLMTextDelta,
  LLMToolCall,
  LLMToolInputDelta,
  LLMToolInputStart,
  LLMUsage,
  LoopConfig,
  runModelTurn,
  type LLMEvent,
  type LLMRequest
} from '../../src/loop'
import { FauxProvider } from '../../src/loop/testing'
import { propertyOptions } from './property-options'

const providerFragment = Schema.Literals([
  'text',
  'reasoning',
  'usage',
  'toolCall',
  'toolInputStart',
  'toolInputDelta',
  'providerToolResult'
])

const validProviderCase = Schema.Struct({
  fragments: Schema.Array(providerFragment)
})

const validProviderCaseArbitrary = Schema.toArbitrary(validProviderCase)

const invalidProviderCase = Schema.Struct({
  fragments: Schema.Array(providerFragment),
  done: Schema.Literals(['none', 'duplicate', 'wrongReason'])
})

const invalidProviderCaseArbitrary = Schema.toArbitrary(invalidProviderCase)

const retryableFailureCase = Schema.Struct({
  failuresBeforeSuccess: Schema.Literals([0, 1, 2, 3, 4]),
  cause: Schema.Literals(['provider_error', 'rate_limit'])
})

const retryableFailureCaseArbitrary = Schema.toArbitrary(retryableFailureCase)

const nonRetryableFailureCase = Schema.Struct({
  cause: Schema.Literals(['provider_error', 'context_overflow']),
  retryable: Schema.Boolean,
  emitsBeforeFailure: Schema.Boolean
})

const nonRetryableFailureCaseArbitrary = Schema.toArbitrary(nonRetryableFailureCase)

const weatherCall = ToolCall.make({ id: 'call_1', name: 'weather', params: { city: 'Paris' } })

const providerToolCall = ToolCall.make({
  id: 'provider_call_1',
  name: 'provider_search',
  params: { query: 'docs' }
})

const providerToolResult = ToolResult.make({
  toolCallId: providerToolCall.id,
  content: 'provider result'
})

const usage = AgentUsage.make({
  input: AgentInputUsage.make({ total: 2 }),
  output: AgentOutputUsage.make({ total: 3 })
})

const eventForFragment = (fragment: typeof providerFragment.Type, index: number): LLMEvent => {
  switch (fragment) {
    case 'text':
      return LLMTextDelta.make({ text: `t${index}` })
    case 'reasoning':
      return LLMReasoningDelta.make({ text: `r${index}` })
    case 'usage':
      return LLMUsage.make({ usage })
    case 'toolCall':
      return LLMToolCall.make({ call: weatherCall })
    case 'toolInputStart':
      return LLMToolInputStart.make({ id: weatherCall.id, name: weatherCall.name })
    case 'toolInputDelta':
      return LLMToolInputDelta.make({ id: weatherCall.id, delta: `d${index}` })
    case 'providerToolResult':
      return LLMProviderToolResult.make({ call: providerToolCall, result: providerToolResult })
  }
}

const fragmentsToEvents = (fragments: ReadonlyArray<typeof providerFragment.Type>) =>
  fragments.slice(0, 24).map(eventForFragment)

const hasHostToolCall = (events: ReadonlyArray<LLMEvent>) =>
  events.some(event => event._tag === 'ToolCall')

const expectedStopReason = (events: ReadonlyArray<LLMEvent>) =>
  hasHostToolCall(events) ? 'tool_use' : 'stop'

const eventsWithDone = (input: typeof validProviderCase.Type) => {
  const events = fragmentsToEvents(input.fragments)
  return [...events, LLMDone.make({ stopReason: expectedStopReason(events) })]
}

const invalidEvents = (input: typeof invalidProviderCase.Type) => {
  const events = fragmentsToEvents(input.fragments)
  const validReason = hasHostToolCall(events) ? 'tool_use' : 'stop'

  switch (input.done) {
    case 'none':
      return events
    case 'duplicate':
      return [
        ...events,
        LLMDone.make({ stopReason: validReason }),
        LLMDone.make({ stopReason: validReason })
      ]
    case 'wrongReason':
      return [...events, LLMDone.make({ stopReason: validReason === 'stop' ? 'tool_use' : 'stop' })]
  }
}

const makeLayer = (events: ReadonlyArray<LLMEvent>, requests: Array<LLMRequest>) =>
  Layer.mergeAll(
    ContextTransformer.identity,
    LoopConfig.defaultLayer,
    FauxProvider.layerWithRequests({ responses: [{ events }], requests })
  )

const retryLoopConfig = LoopConfig.layer({
  maxTurns: 1,
  maxRetries: 2,
  retryBaseDelayMs: 0,
  toolConcurrency: 1
})

const retrySuccessEvents: ReadonlyArray<LLMEvent> = [
  LLMTextDelta.make({ text: 'ok' }),
  LLMDone.make({ stopReason: 'stop' })
]

const makeRetryableLayer = (input: {
  readonly requests: Array<LLMRequest>
  readonly failuresBeforeSuccess: number
  readonly cause: typeof retryableFailureCase.Type.cause
}) => {
  let attempts = 0

  return Layer.mergeAll(
    ContextTransformer.identity,
    retryLoopConfig,
    Layer.succeed(
      LLMProvider,
      LLMProvider.of({
        stream: request => {
          input.requests.push(request)
          attempts += 1

          return attempts <= input.failuresBeforeSuccess
            ? Stream.fail(
                new LLMError({
                  cause: input.cause,
                  message: 'retryable failure',
                  retryable: true
                })
              )
            : Stream.fromIterable(retrySuccessEvents)
        }
      })
    )
  )
}

const makeNonRetryableLayer = (input: {
  readonly requests: Array<LLMRequest>
  readonly cause: typeof nonRetryableFailureCase.Type.cause
  readonly retryable: boolean
  readonly emitsBeforeFailure: boolean
}) =>
  Layer.mergeAll(
    ContextTransformer.identity,
    retryLoopConfig,
    Layer.succeed(
      LLMProvider,
      LLMProvider.of({
        stream: request => {
          input.requests.push(request)
          const failure = Stream.fail(
            new LLMError({
              cause: input.cause,
              message: 'terminal failure',
              retryable: input.retryable
            })
          )

          return input.emitsBeforeFailure
            ? Stream.make(LLMTextDelta.make({ text: 'partial' })).pipe(Stream.concat(failure))
            : failure
        }
      })
    )
  )

const collectModelTurnEventsWithLayer = () =>
  Effect.gen(function* () {
    const collected: Array<AgentEvent> = []

    yield* runModelTurn({
      messages: [UserMessage.make({ content: 'hello' })],
      systemPrompt: 'Be brief.',
      tools: [],
      model: 'faux',
      turn: 1
    }).pipe(
      Stream.runForEach(event =>
        Effect.sync(() => {
          collected.push(event)
        })
      )
    )

    return collected
  })

const collectModelTurnEvents = (events: ReadonlyArray<LLMEvent>, requests: Array<LLMRequest>) =>
  collectModelTurnEventsWithLayer().pipe(Effect.provide(makeLayer(events, requests)))

const countTag = (events: ReadonlyArray<AgentEvent>, tag: AgentEvent['_tag']) =>
  events.filter(event => event._tag === tag).length

const collectRetryRun = <R>(layer: Layer.Layer<R>) =>
  collectModelTurnEventsWithLayer().pipe(Effect.provide(layer))

describe('provider stream property tests', () => {
  it.effect.prop(
    'valid provider streams emit a single ordered model-turn lifecycle',
    [validProviderCaseArbitrary],
    ([input]) => {
      const requests: Array<LLMRequest> = []
      const llmEvents = eventsWithDone(input)

      return Effect.gen(function* () {
        const events = yield* collectModelTurnEvents(llmEvents, requests)
        const tags = events.map(event => event._tag)

        expect(requests).toHaveLength(1)
        expect(tags[0]).toBe('TurnStart')
        expect(tags[1]).toBe('LLMStreamStart')
        expect(countTag(events, 'LLMStreamEnd')).toBe(1)
        expect(countTag(events, 'AssistantMessage')).toBe(1)
        expect(countTag(events, 'TurnEnd')).toBe(1)
        expect(tags.indexOf('LLMStreamStart')).toBeLessThan(tags.indexOf('LLMStreamEnd'))
        expect(tags.indexOf('LLMStreamEnd')).toBeLessThan(tags.indexOf('AssistantMessage'))
        expect(tags.indexOf('AssistantMessage')).toBeLessThan(tags.indexOf('TurnEnd'))
        expect(countTag(events, 'LLMTextDelta')).toBe(
          llmEvents.filter(event => event._tag === 'TextDelta').length
        )
        expect(countTag(events, 'LLMReasoningDelta')).toBe(
          llmEvents.filter(event => event._tag === 'ReasoningDelta').length
        )
        expect(countTag(events, 'UsageUpdate')).toBe(
          llmEvents.filter(event => event._tag === 'Usage').length
        )
        expect(countTag(events, 'ToolInputEnd')).toBe(
          llmEvents.filter(event => event._tag === 'ToolCall').length
        )
      })
    },
    propertyOptions
  )

  it.effect.prop(
    'invalid provider stream completion fails without a turn end',
    [invalidProviderCaseArbitrary],
    ([input]) => {
      const requests: Array<LLMRequest> = []

      return Effect.gen(function* () {
        const result = yield* collectModelTurnEvents(invalidEvents(input), requests).pipe(
          Effect.result
        )

        expect(requests).toHaveLength(1)
        expect(result).toMatchObject({
          _tag: 'Failure',
          failure: { _tag: 'LLMError', cause: 'invalid_response' }
        })
      })
    },
    propertyOptions
  )

  it.effect.prop(
    'retryable pre-emission provider failures retry until success or max retries',
    [retryableFailureCaseArbitrary],
    ([input]) => {
      const requests: Array<LLMRequest> = []
      const expectedRetries = Math.min(input.failuresBeforeSuccess, 2)
      const shouldSucceed = input.failuresBeforeSuccess <= 2

      return Effect.gen(function* () {
        const result = yield* collectRetryRun(
          makeRetryableLayer({
            requests,
            failuresBeforeSuccess: input.failuresBeforeSuccess,
            cause: input.cause
          })
        ).pipe(Effect.result)

        expect(requests).toHaveLength(shouldSucceed ? input.failuresBeforeSuccess + 1 : 3)

        if (shouldSucceed) {
          expect(result).toMatchObject({ _tag: 'Success' })
          if (result._tag === 'Success') {
            expect(countTag(result.success, 'AgentRetry')).toBe(expectedRetries)
            expect(countTag(result.success, 'TurnEnd')).toBe(1)
          }
        } else {
          expect(result).toMatchObject({
            _tag: 'Failure',
            failure: { _tag: 'LLMError', cause: input.cause }
          })
        }
      })
    },
    propertyOptions
  )

  it.effect.prop(
    'non-retryable or post-emission provider failures do not retry',
    [nonRetryableFailureCaseArbitrary],
    ([input]) => {
      const requests: Array<LLMRequest> = []
      const retryable = input.cause === 'context_overflow' ? true : input.retryable

      return Effect.gen(function* () {
        const result = yield* collectRetryRun(
          makeNonRetryableLayer({
            requests,
            cause: input.cause,
            retryable,
            emitsBeforeFailure: input.emitsBeforeFailure
          })
        ).pipe(Effect.result)

        if (retryable && input.cause !== 'context_overflow' && !input.emitsBeforeFailure) {
          expect(requests).toHaveLength(3)
        } else {
          expect(requests).toHaveLength(1)
        }

        expect(result).toMatchObject({
          _tag: 'Failure',
          failure: { _tag: 'LLMError', cause: input.cause }
        })
      })
    },
    propertyOptions
  )
})
