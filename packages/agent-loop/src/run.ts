import { Effect, Stream } from 'effect'
import {
  AgentEnd,
  AgentRetry,
  AgentStart,
  AssistantMessageEvent,
  UsageUpdate,
  addAgentUsage,
  contentParts,
  LLMToolCall as AgentLLMToolCall,
  LLMReasoningDelta as AgentLLMReasoningDelta,
  LLMStreamEnd,
  LLMStreamStart,
  LLMTextDelta as AgentLLMTextDelta,
  ToolExecutionEnd,
  ToolExecutionStart,
  ToolResultEvent,
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
} from '@yolk/protocol'
import { accumulateAssistantMessage, collectToolCalls } from './accumulator.ts'
import { AbortError, LLMError, type AgentLoopError, type ToolError } from './error.ts'
import type { LLMEvent } from './llm-event.ts'
import { ContextTransformer, type ContextTransformResult } from './services/context-transformer.ts'
import { LLMProvider, type LLMRequest } from './services/llm-provider.ts'
import { LoopConfig } from './services/loop-config.ts'
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

const unsupportedInputError = (message: string) =>
  new LLMError({
    cause: 'validation_error',
    message,
    retryable: false
  })

const validateContent = (message: AgentMessage, capabilities: AgentModelCapabilities) =>
  Effect.forEach(contentParts(message.content), part => {
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

const toLlmEvents = (llmEvents: ReadonlyArray<LLMEvent>): ReadonlyArray<AgentEvent> => {
  const events: Array<AgentEvent> = []

  for (const event of llmEvents) {
    switch (event._tag) {
      case 'TextDelta':
        events.push(AgentLLMTextDelta.make({ text: event.text }))
        break
      case 'ReasoningDelta':
        events.push(AgentLLMReasoningDelta.make({ text: event.text }))
        break
      case 'ToolCall':
        events.push(AgentLLMToolCall.make({ call: event.call }))
        break
      case 'Usage':
        events.push(UsageUpdate.make({ usage: event.usage }))
        break
      case 'Done':
        break
    }
  }

  return events
}

const toLlmEvent = (event: LLMEvent): ReadonlyArray<AgentEvent> => toLlmEvents([event])

const isLlmEvent = (event: LLMEvent | AgentEvent | AgentRetry): event is LLMEvent => {
  switch (event._tag) {
    case 'TextDelta':
    case 'ReasoningDelta':
    case 'Done':
    case 'ToolCall':
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
    ) => Effect.Effect<ContextTransformResult>
  }
  readonly loopConfig: {
    readonly maxTurns: number
    readonly maxRetries: number
    readonly retryBaseDelayMs: number
  }
  readonly provider: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, AgentLoopError>
  }
  readonly executor: {
    readonly execute: (call: ToolCall) => Effect.Effect<ToolResult, ToolError>
  }
  readonly currentMessages: ReadonlyArray<AgentMessage>
  readonly createdMessages: Array<AgentMessage>
  readonly usage: { current: AgentUsage }
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
  stream: Stream.Stream<LLMEvent, AgentLoopError>,
  loopConfig: TurnStreamInput['loopConfig'],
  makeStream: () => Stream.Stream<LLMEvent, AgentLoopError>,
  attempt: number
): Stream.Stream<LLMEvent | AgentRetry, AgentLoopError> => {
  let emittedProviderEvent = false

  return stream.pipe(
    Stream.tap(() =>
      Effect.sync(() => {
        emittedProviderEvent = true
      })
    ),
    Stream.catchTags({
      LLMError: error => {
        if (
          emittedProviderEvent ||
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
          Stream.concat(withProviderRetries(makeStream(), loopConfig, makeStream, attempt + 1))
        )
      },
      AbortError: failAgentLoopError,
      FauxExhaustedError: failAgentLoopError,
      ToolError: failAgentLoopError
    })
  )
}

const makeToolExecutionStream = (
  executor: TurnStreamInput['executor'],
  call: ToolCall,
  createdMessages: Array<AgentMessage>,
  toolResultMessages: Array<AgentMessage>
): Stream.Stream<AgentEvent, AgentLoopError> =>
  Stream.make(ToolExecutionStart.make({ call })).pipe(
    Stream.concat(
      Stream.fromEffect(
        executor.execute(call).pipe(
          Effect.map(result => {
            const toolResultMessage = ToolResultMessage.make({
              toolCallId: result.toolCallId,
              content: result.content
            })

            createdMessages.push(toolResultMessage)
            toolResultMessages.push(toolResultMessage)

            return [ToolExecutionEnd.make({ call, result }), ToolResultEvent.make({ result })]
          })
        )
      ).pipe(Stream.flatMap(events => Stream.fromIterable(events)))
    )
  )

const makeTurnStream = (input: TurnStreamInput): Stream.Stream<AgentEvent, AgentLoopError> =>
  Stream.suspend(() => {
    if (input.turn > input.loopConfig.maxTurns) {
      return Stream.fail(new AbortError({ reason: 'max_turns' }))
    }

    const llmEvents: Array<LLMEvent> = []
    const llmStream = Stream.unwrap(
      input.contextTransformer.transform(input.currentMessages).pipe(
        Effect.tap(result => validateCapabilities(input.config, result.messages)),
        Effect.map(result => {
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
              Stream.tap(event =>
                Effect.sync(() => {
                  if (isLlmEvent(event) && event._tag === 'Usage') {
                    input.usage.current = addAgentUsage(input.usage.current, event.usage)
                  }
                  if (isLlmEvent(event)) {
                    llmEvents.push(event)
                  }
                })
              ),
              Stream.flatMap(event =>
                event._tag === 'AgentRetry'
                  ? Stream.make(event)
                  : isLlmEvent(event)
                    ? Stream.fromIterable(toLlmEvent(event))
                    : Stream.make(event)
              )
            )
        })
      )
    )

    const afterLlmStream = Stream.suspend(() => {
      const toolCalls = collectToolCalls(llmEvents)
      const assistantMessage = accumulateAssistantMessage(llmEvents)
      const turnEndEvents: Array<AgentEvent> = [
        LLMStreamEnd.make({ turn: input.turn }),
        AssistantMessageEvent.make({ message: assistantMessage })
      ]

      input.createdMessages.push(assistantMessage)

      if (toolCalls.length === 0) {
        return Stream.fromIterable([
          ...turnEndEvents,
          TurnEnd.make({ turn: input.turn, reason: 'stop' }),
          AgentEnd.make({
            messages: [...input.createdMessages],
            turns: input.turn,
            usage: input.usage.current
          })
        ])
      }

      const toolResultMessages: Array<AgentMessage> = []
      const toolExecutionStream = Stream.fromIterable(toolCalls).pipe(
        Stream.flatMap(call =>
          makeToolExecutionStream(input.executor, call, input.createdMessages, toolResultMessages)
        )
      )
      const nextTurnStream = Stream.suspend(() =>
        Stream.make(TurnEnd.make({ turn: input.turn, reason: 'tool_use' })).pipe(
          Stream.concat(
            makeTurnStream({
              ...input,
              currentMessages: [...input.currentMessages, assistantMessage, ...toolResultMessages],
              usage: input.usage,
              turn: input.turn + 1
            })
          )
        )
      )

      return Stream.fromIterable(turnEndEvents).pipe(
        Stream.concat(toolExecutionStream),
        Stream.concat(nextTurnStream)
      )
    })

    return Stream.fromIterable([
      TurnStart.make({ turn: input.turn }),
      LLMStreamStart.make({ turn: input.turn })
    ]).pipe(Stream.concat(llmStream), Stream.concat(afterLlmStream))
  })

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
      const createdMessages: Array<AgentMessage> = []
      const usage = { current: zeroAgentUsage }

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
