import { Effect, Ref, Stream } from 'effect'
import {
  AgentEnd,
  AgentRetry,
  AgentStart,
  AssistantMessageEvent,
  UsageUpdate,
  addAgentUsage,
  contentParts,
  LLMReasoningDelta as AgentLLMReasoningDelta,
  LLMStreamEnd,
  LLMStreamStart,
  LLMTextDelta as AgentLLMTextDelta,
  ToolExecutionCompleted,
  ToolExecutionError,
  ToolExecutionStarted,
  ToolInputEnd,
  ToolInputDelta,
  ToolInputStart,
  ProviderToolResult,
  ToolResultMessage,
  type ToolCall,
  type AgentReasoningEffort,
  type ToolResult,
  TurnEnd,
  TurnStart,
  zeroAgentUsage,
  type AgentEvent,
  type AgentErrorCode,
  type AgentMessage,
  type AgentUsage,
  type AgentModelCapabilities,
  type ToolDef
} from '@yolk/agent/protocol'
import { accumulateAssistantMessage, collectToolCalls } from './accumulator.ts'
import {
  AbortError,
  LLMError,
  ToolError,
  type AgentLoopError,
  type LLMProviderError,
} from './error.ts'
import type { LLMEvent } from './llm-event.ts'
import { ContextTransformer, type ContextTransformResult } from './services/context-transformer.ts'
import { LLMProvider, type LLMRequest } from './services/llm-provider.ts'
import { LoopConfig, type LoopConfigShape } from './services/loop-config.ts'
import { ToolExecutor } from './services/tool-executor.ts'

export type AgentLoopRunId = string

export type RunConfig = {
  readonly messages: ReadonlyArray<AgentMessage>
  readonly systemPrompt: string
  readonly tools: ReadonlyArray<ToolDef>
  readonly model: string
  readonly reasoningEffort?: AgentReasoningEffort
  readonly capabilities?: AgentModelCapabilities
}

export type ModelTurnConfig = RunConfig & {
  readonly turn: number
}

export type ToolBatchConfig = {
  readonly calls: ReadonlyArray<ToolCall>
}

const unsupportedInputError = (message: string) =>
  new LLMError({
    cause: 'validation_error',
    message,
    retryable: false
  })

const validateContent = (message: AgentMessage, capabilities: AgentModelCapabilities) =>
  Effect.forEach(contentPartsFromMessage(message), part => {
    switch (part._tag) {
      case 'Text':
        return capabilities.input.text
          ? Effect.void
          : Effect.fail(unsupportedInputError('Text input is not supported by this model'))
      case 'Image':
        return capabilities.input.image
          ? Effect.void
          : Effect.fail(unsupportedInputError('Image input is not supported by this model'))
      case 'Audio':
        return capabilities.input.audio
          ? Effect.void
          : Effect.fail(unsupportedInputError('Audio input is not supported by this model'))
    }
  })

const contentPartsFromMessage = (message: AgentMessage) => {
  switch (message._tag) {
    case 'User':
    case 'ToolResult':
      return contentParts(message.content)
    case 'Assistant':
      return message.parts.flatMap(part => (part._tag === 'Text' ? contentParts(part.content) : []))
  }
}

const validateCapabilities = (
  config: RunConfig,
  messages: ReadonlyArray<AgentMessage>
): Effect.Effect<void, LLMError> => {
  const capabilities = config.capabilities

  if (capabilities === undefined) {
    return Effect.void
  }

  if (!capabilities.tools && config.tools.length > 0) {
    return Effect.fail(unsupportedInputError('Tools are not supported by this model'))
  }

  if (!capabilities.reasoning && config.reasoningEffort !== undefined) {
    return Effect.fail(unsupportedInputError('Reasoning effort is not supported by this model'))
  }

  return Effect.forEach(messages, message => validateContent(message, capabilities)).pipe(
    Effect.asVoid
  )
}

const toLlmEvent = (event: LLMEvent): ReadonlyArray<AgentEvent> => {
  switch (event._tag) {
    case 'TextDelta':
      return [AgentLLMTextDelta.make({ text: event.text })]
    case 'ReasoningDelta':
      return [AgentLLMReasoningDelta.make({ text: event.text })]
    case 'ToolCall':
      return [ToolInputEnd.make({ call: event.call })]
    case 'ToolInputStart':
      return [ToolInputStart.make({ id: event.id, name: event.name })]
    case 'ToolInputDelta':
      return [ToolInputDelta.make({ id: event.id, delta: event.delta })]
    case 'ProviderToolResult':
      return [ProviderToolResult.make({ call: event.call, result: event.result })]
    case 'Usage':
      return [UsageUpdate.make({ usage: event.usage })]
    case 'Done':
      return []
  }
}

const isLlmEvent = (event: LLMEvent | AgentEvent | AgentRetry): event is LLMEvent => {
  switch (event._tag) {
    case 'TextDelta':
    case 'ReasoningDelta':
    case 'Done':
    case 'ToolCall':
    case 'ToolInputStart':
    case 'ToolInputDelta':
    case 'ProviderToolResult':
    case 'Usage':
      return true
    default:
      return false
  }
}

type TurnStreamInput = {
  readonly config: RunConfig
  readonly contextTransformer: {
    readonly transform: (
      messages: ReadonlyArray<AgentMessage>
    ) => Effect.Effect<ContextTransformResult, AgentLoopError>
  }
  readonly loopConfig: LoopConfigShape
  readonly provider: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMProviderError>
  }
  readonly executor: {
    readonly execute: (call: ToolCall) => Effect.Effect<ToolResult, ToolError>
  }
  readonly currentMessages: ReadonlyArray<AgentMessage>
  readonly createdMessages: Ref.Ref<ReadonlyArray<AgentMessage>>
  readonly usage: Ref.Ref<AgentUsage>
  readonly turn: number
}

const retryDelayMs = (baseDelayMs: number, attempt: number) =>
  Math.max(0, Math.floor(baseDelayMs * 2 ** Math.max(0, attempt - 1)))

const retryReason = (error: LLMError): AgentErrorCode => error.cause

const retrySleep = (delayMs: number) =>
  delayMs === 0 ? Effect.void : Effect.sleep(`${delayMs} millis`)

const failAgentLoopError = (
  error: AgentLoopError
): Stream.Stream<LLMEvent | AgentRetry, AgentLoopError> => Stream.fail(error)

const sleepStream = (delayMs: number): Stream.Stream<LLMEvent | AgentRetry, AgentLoopError> =>
  Stream.fromEffect(retrySleep(delayMs)).pipe(Stream.flatMap(() => Stream.empty))

const withProviderRetries = (
  stream: Stream.Stream<LLMEvent, LLMProviderError>,
  loopConfig: TurnStreamInput['loopConfig'],
  makeStream: () => Stream.Stream<LLMEvent, LLMProviderError>,
  attempt: number
): Stream.Stream<LLMEvent | AgentRetry, AgentLoopError> =>
  Stream.unwrap(
    Ref.make(false).pipe(
      Effect.map(emittedProviderEvent =>
        stream.pipe(
          Stream.tap(() => Ref.set(emittedProviderEvent, true)),
          Stream.catchTags({
            LLMError: error =>
              Stream.unwrap(
                Ref.get(emittedProviderEvent).pipe(
                  Effect.map(emitted => {
                    if (
                      emitted ||
                      !error.retryable ||
                      error.cause === 'context_overflow' ||
                      attempt > loopConfig.maxRetries
                    ) {
                      return failAgentLoopError(error)
                    }

                    const delayMs = retryDelayMs(loopConfig.retryBaseDelayMs, attempt)
                    return Stream.make(
                      AgentRetry.make({
                        attempt,
                        reason: retryReason(error),
                        delayMs,
                        message: error.message
                      })
                    ).pipe(
                      Stream.concat(sleepStream(delayMs)),
                      Stream.concat(
                        withProviderRetries(makeStream(), loopConfig, makeStream, attempt + 1)
                      )
                    )
                  })
                )
              ),
            AbortError: failAgentLoopError,
            FauxExhaustedError: failAgentLoopError
          })
        )
      )
    )
  )

const makeToolExecutionStream = (
  executor: TurnStreamInput['executor'],
  call: ToolCall
): Stream.Stream<AgentEvent, AgentLoopError> =>
  Stream.make(ToolExecutionStarted.make({ call })).pipe(
    Stream.concat(
      Stream.fromEffect(
        executor.execute(call).pipe(
          Effect.map(result => ToolExecutionCompleted.make({ call, result }))
        )
      ).pipe(
        Stream.catchTag('ToolError', error =>
          Stream.make(
            ToolExecutionError.make({
              call,
              message: error.message,
              code: toolErrorCode(error)
            })
          ).pipe(Stream.concat(Stream.fail(error)))
        )
      )
    )
  )

type IndexedToolResultMessage = {
  readonly index: number
  readonly message: AgentMessage
}

const boundedToolConcurrency = (loopConfig: LoopConfigShape) =>
  Math.max(1, loopConfig.toolConcurrency)

const toolResultMessageFromResult = (result: ToolResult) =>
  ToolResultMessage.make({
    toolCallId: result.toolCallId,
    content: result.content,
    isError: result.isError,
    structuredContent: result.structuredContent
  })

const orderedToolResultMessages = (results: ReadonlyArray<IndexedToolResultMessage>) =>
  [...results].sort((left, right) => left.index - right.index).map(result => result.message)

const parallelToolExecutionStream = (input: {
  readonly calls: ReadonlyArray<ToolCall>
  readonly executor: TurnStreamInput['executor']
  readonly loopConfig: LoopConfigShape
  readonly results: Ref.Ref<ReadonlyArray<IndexedToolResultMessage>>
}) =>
  Stream.mergeAll(
    input.calls.map((call, index) =>
      makeToolExecutionStream(input.executor, call).pipe(
        Stream.tap(event => {
          if (event._tag !== 'ToolExecutionCompleted') {
            return Effect.void
          }

          return Ref.update(input.results, results => [
            ...results,
            { index, message: toolResultMessageFromResult(event.result) }
          ])
        })
      )
    ),
    { concurrency: boundedToolConcurrency(input.loopConfig) }
  )

const toolErrorCode = (error: ToolError): AgentErrorCode => {
  switch (error.cause) {
    case 'validation':
    case 'invalid_input':
      return 'validation_error'
    case 'timeout':
      return 'tool_timeout'
    case 'permission':
    case 'denied':
      return 'tool_denied'
    case 'execution':
    case 'not_found':
    case 'unavailable':
      return 'tool_error'
  }
}

type TurnCompletion = {
  readonly toolCalls: ReadonlyArray<ToolCall>
  readonly stopReason: 'stop' | 'tool_use'
}

const validateTurnCompletion = (
  events: ReadonlyArray<LLMEvent>
): Effect.Effect<TurnCompletion, LLMError> => {
  const doneEvents = events.filter(event => event._tag === 'Done')
  const toolCalls = collectToolCalls(events)
  const stopReason: TurnCompletion['stopReason'] = toolCalls.length === 0 ? 'stop' : 'tool_use'

  if (doneEvents.length !== 1) {
    return Effect.fail(
      new LLMError({
        cause: 'invalid_response',
        message: `Expected exactly one LLM done event, received ${doneEvents.length}`,
        retryable: false
      })
    )
  }

  const doneEvent = doneEvents[0]

  if (doneEvent === undefined || doneEvent.stopReason !== stopReason) {
    return Effect.fail(
      new LLMError({
        cause: 'invalid_response',
        message: `LLM done reason must be ${stopReason}`,
        retryable: false
      })
    )
  }

  return Effect.succeed({ toolCalls, stopReason })
}

const makeAfterLlmStream = (
  input: TurnStreamInput,
  llmEventsRef: Ref.Ref<ReadonlyArray<LLMEvent>>
): Stream.Stream<AgentEvent, AgentLoopError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const llmEvents = yield* Ref.get(llmEventsRef)
      const completion = yield* validateTurnCompletion(llmEvents)
      const assistantMessage = accumulateAssistantMessage(llmEvents)
      const turnEndEvents: ReadonlyArray<AgentEvent> = [
        LLMStreamEnd.make({ turn: input.turn }),
        AssistantMessageEvent.make({ message: assistantMessage })
      ]

      yield* Ref.update(input.createdMessages, messages => [...messages, assistantMessage])

      if (completion.toolCalls.length === 0) {
        const messages = yield* Ref.get(input.createdMessages)
        const usage = yield* Ref.get(input.usage)

        return Stream.fromIterable([
          ...turnEndEvents,
          TurnEnd.make({ turn: input.turn, reason: completion.stopReason }),
          AgentEnd.make({
            messages,
            turns: input.turn,
            usage
          })
        ])
      }

      const toolResultMessages = yield* Ref.make<ReadonlyArray<IndexedToolResultMessage>>([])
      const toolExecutionStream = parallelToolExecutionStream({
        calls: completion.toolCalls,
        executor: input.executor,
        loopConfig: input.loopConfig,
        results: toolResultMessages
      })
      const nextTurnStream = Stream.unwrap(
        Ref.get(toolResultMessages).pipe(
          Effect.flatMap(results => {
            const orderedResults = orderedToolResultMessages(results)

            return Ref.update(input.createdMessages, messages => [...messages, ...orderedResults]).pipe(
              Effect.as(
                Stream.make(TurnEnd.make({ turn: input.turn, reason: completion.stopReason })).pipe(
                  Stream.concat(
                    makeTurnStream({
                      ...input,
                      currentMessages: [...input.currentMessages, assistantMessage, ...orderedResults],
                      turn: input.turn + 1
                    })
                  )
                )
              )
            )
          })
        )
      )

      return Stream.fromIterable(turnEndEvents).pipe(
        Stream.concat(toolExecutionStream),
        Stream.concat(nextTurnStream)
      )
    })
  )

const makeModelOnlyAfterLlmStream = (
  input: TurnStreamInput,
  llmEventsRef: Ref.Ref<ReadonlyArray<LLMEvent>>
): Stream.Stream<AgentEvent, AgentLoopError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const llmEvents = yield* Ref.get(llmEventsRef)
      const completion = yield* validateTurnCompletion(llmEvents)
      const assistantMessage = accumulateAssistantMessage(llmEvents)

      yield* Ref.update(input.createdMessages, messages => [...messages, assistantMessage])

      return Stream.fromIterable([
        LLMStreamEnd.make({ turn: input.turn }),
        AssistantMessageEvent.make({ message: assistantMessage }),
        TurnEnd.make({ turn: input.turn, reason: completion.stopReason })
      ])
    })
  )

const makeLlmStream = (
  input: TurnStreamInput,
  llmEvents: Ref.Ref<ReadonlyArray<LLMEvent>>,
  result: ContextTransformResult
): Stream.Stream<AgentEvent, AgentLoopError> => {
  const makeStream = () =>
    input.provider.stream({
      messages: result.messages,
      tools: input.config.tools,
      model: input.config.model,
      reasoningEffort: input.config.reasoningEffort,
      systemPrompt: input.config.systemPrompt
    })

  return Stream.fromIterable(result.events)
    .pipe(Stream.concat(withProviderRetries(makeStream(), input.loopConfig, makeStream, 1)))
    .pipe(
      Stream.tap(event => {
        if (!isLlmEvent(event)) {
          return Effect.void
        }

        const appendEvent = Ref.update(llmEvents, events => [...events, event])

        if (event._tag !== 'Usage') {
          return appendEvent
        }

        return Ref.update(input.usage, usage => addAgentUsage(usage, event.usage)).pipe(
          Effect.flatMap(() => appendEvent)
        )
      }),
      Stream.flatMap(event =>
        event._tag === 'AgentRetry'
          ? Stream.make(event)
          : isLlmEvent(event)
            ? Stream.fromIterable(toLlmEvent(event))
            : Stream.make(event)
      ),
      Stream.concat(makeAfterLlmStream(input, llmEvents))
    )
}

const makeModelOnlyLlmStream = (
  input: TurnStreamInput,
  llmEvents: Ref.Ref<ReadonlyArray<LLMEvent>>,
  result: ContextTransformResult
): Stream.Stream<AgentEvent, AgentLoopError> => {
  const makeStream = () =>
    input.provider.stream({
      messages: result.messages,
      tools: input.config.tools,
      model: input.config.model,
      reasoningEffort: input.config.reasoningEffort,
      systemPrompt: input.config.systemPrompt
    })

  return Stream.fromIterable(result.events)
    .pipe(Stream.concat(withProviderRetries(makeStream(), input.loopConfig, makeStream, 1)))
    .pipe(
      Stream.tap(event => {
        if (!isLlmEvent(event)) {
          return Effect.void
        }

        const appendEvent = Ref.update(llmEvents, events => [...events, event])

        if (event._tag !== 'Usage') {
          return appendEvent
        }

        return Ref.update(input.usage, usage => addAgentUsage(usage, event.usage)).pipe(
          Effect.flatMap(() => appendEvent)
        )
      }),
      Stream.flatMap(event =>
        event._tag === 'AgentRetry'
          ? Stream.make(event)
          : isLlmEvent(event)
            ? Stream.fromIterable(toLlmEvent(event))
            : Stream.make(event)
      ),
      Stream.concat(makeModelOnlyAfterLlmStream(input, llmEvents))
    )
}

const makeTurnStream = (input: TurnStreamInput): Stream.Stream<AgentEvent, AgentLoopError> =>
  Stream.suspend(() => {
    if (input.turn > input.loopConfig.maxTurns) {
      return Stream.fail(new AbortError({ reason: 'max_turns' }))
    }

    const llmStream = Stream.unwrap(
      Effect.gen(function* () {
        const llmEvents = yield* Ref.make<ReadonlyArray<LLMEvent>>([])
        const result = yield* input.contextTransformer.transform(input.currentMessages)
        yield* validateCapabilities(input.config, result.messages)

        return makeLlmStream(input, llmEvents, result)
      })
    )

    return Stream.fromIterable([
      TurnStart.make({ turn: input.turn }),
      LLMStreamStart.make({ turn: input.turn })
    ]).pipe(Stream.concat(llmStream))
  })

const unavailableToolExecutor: TurnStreamInput['executor'] = {
  execute: call =>
    Effect.fail(
      new ToolError({
        tool: call.name,
        message: 'Tool execution is not available in model turn step',
        cause: 'execution'
      })
    )
}

const makeModelOnlyTurnStream = (
  input: TurnStreamInput
): Stream.Stream<AgentEvent, AgentLoopError> =>
  Stream.suspend(() => {
    if (input.turn > input.loopConfig.maxTurns) {
      return Stream.fail(new AbortError({ reason: 'max_turns' }))
    }

    const llmStream = Stream.unwrap(
      Effect.gen(function* () {
        const llmEvents = yield* Ref.make<ReadonlyArray<LLMEvent>>([])
        const result = yield* input.contextTransformer.transform(input.currentMessages)
        yield* validateCapabilities(input.config, result.messages)

        return makeModelOnlyLlmStream(input, llmEvents, result)
      })
    )

    return Stream.fromIterable([
      TurnStart.make({ turn: input.turn }),
      LLMStreamStart.make({ turn: input.turn })
    ]).pipe(Stream.concat(llmStream))
  })

export const runModelTurn = (
  config: ModelTurnConfig
): Stream.Stream<AgentEvent, AgentLoopError, ContextTransformer | LLMProvider | LoopConfig> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const contextTransformer = yield* ContextTransformer
      const loopConfig = yield* LoopConfig
      const provider = yield* LLMProvider
      const createdMessages = yield* Ref.make<ReadonlyArray<AgentMessage>>([])
      const usage = yield* Ref.make(zeroAgentUsage)

      return makeModelOnlyTurnStream({
        config,
        contextTransformer,
        loopConfig,
        provider,
        executor: unavailableToolExecutor,
        currentMessages: config.messages,
        createdMessages,
        usage,
        turn: config.turn
      })
    })
  )

export const runToolBatch = (
  config: ToolBatchConfig
): Stream.Stream<AgentEvent, AgentLoopError, LoopConfig | ToolExecutor> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const executor = yield* ToolExecutor
      const loopConfig = yield* LoopConfig
      const toolResultMessages = yield* Ref.make<ReadonlyArray<IndexedToolResultMessage>>([])

      return parallelToolExecutionStream({
        calls: config.calls,
        executor,
        loopConfig,
        results: toolResultMessages
      })
    })
  )

export const run = (
  config: RunConfig
): Stream.Stream<
  AgentEvent,
  AgentLoopError,
  ContextTransformer | LLMProvider | LoopConfig | ToolExecutor
> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const contextTransformer = yield* ContextTransformer
      const loopConfig = yield* LoopConfig
      const provider = yield* LLMProvider
      const executor = yield* ToolExecutor
      const createdMessages = yield* Ref.make<ReadonlyArray<AgentMessage>>([])
      const usage = yield* Ref.make(zeroAgentUsage)

      return Stream.make(AgentStart.make({})).pipe(
        Stream.concat(
          makeTurnStream({
            config,
            contextTransformer,
            loopConfig,
            provider,
            executor,
            currentMessages: config.messages,
            createdMessages,
            usage,
            turn: 1
          })
        )
      )
    })
  )
